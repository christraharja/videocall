const socket = io();

// DOM Elements
const startCallBtn = document.getElementById("startCall");
const joinCallBtn = document.getElementById("joinCall");
const roomIdInput = document.getElementById("roomId");
const roomNumberDisplay = document.getElementById("roomNumber");
const activeRoomDisplay = document.getElementById("activeRoomNumber");
const generatedIdDisplay = document.getElementById("generatedId");
const setupScreen = document.querySelector(".setup-screen");
const callScreen = document.querySelector(".call-screen");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const muteAudioBtn = document.getElementById("muteAudio");
const muteVideoBtn = document.getElementById("muteVideo");
const joinRequestsContainer = document.getElementById("joinRequests");

// Global State
let localPeerConnection;
let myStream;
let roomId;
let myUserId;
let isRoomHost = false;
let audioEnabled = true;
let videoEnabled = true;
let currentRemoteUserId = null;

// ICE servers configuration (STUN/TURN servers)
const iceServers = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" }
  ]
};

// Start new meeting
startCallBtn.onclick = async () => {
  roomId = generateRoomId();
  isRoomHost = true;
  myUserId = generateUserId();
  startCall(roomId);
};

// Join existing meeting
joinCallBtn.onclick = () => {
  const inputId = roomIdInput.value.trim();
  if (!inputId) return alert("Enter a Room ID");
  roomId = inputId;
  isRoomHost = false;
  myUserId = generateUserId();
  startCall(roomId);
};

// Core function to initiate call setup
async function startCall(roomId) {
  try {
    // Get media stream
    myStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    
    // Explicitly ensure audio is enabled
    myStream.getAudioTracks().forEach(track => {
      track.enabled = true;
    });
    audioEnabled = true;
    
    // Update audio button state
    if (muteAudioBtn) {
      muteAudioBtn.textContent = "Mute Audio";
      muteAudioBtn.classList.remove("muted");
    }
    
    localVideo.srcObject = myStream;
    localVideo.muted = true; // Only mute local preview, not the actual stream
    localVideo.play();
    
    console.log("Audio tracks enabled:", myStream.getAudioTracks().map(track => track.enabled));
  } catch (err) {
    console.error("Failed to get media stream:", err);
    alert("Could not access camera or microphone. Please check your permissions.");
    return;
  }

  if (isRoomHost) {
    // Host directly joins room
    socket.emit("join-room", roomId, myUserId, "host");
    activeRoomDisplay.textContent = roomId;
    roomNumberDisplay.textContent = roomId;
    setupScreen.classList.add("hidden");
    callScreen.classList.remove("hidden");
    generatedIdDisplay.classList.remove("hidden");
  } else {
    // Joiners request permission first
    socket.emit("request-join", roomId, myUserId);
    document.querySelector(".setup-screen").innerHTML = "<h2>Waiting for host approval...</h2>";
  }

  // Setup socket listeners
  setupSocketEvents();
}

function setupSocketEvents() {
  // For joiner: Connect when approved
  socket.on("join-approved", (userId, hostId) => {
    console.log("Join approved by host:", hostId);
    
    // Only proceed if this approval is for me
    if (userId !== myUserId) return;
    
    // Officially join the room after approval
    socket.emit("join-room", roomId, myUserId, "user");
    
    setupScreen.classList.add("hidden");
    callScreen.classList.remove("hidden");
    activeRoomDisplay.textContent = roomId;
    
    // Create peer connection and send offer to host
    createPeerConnection();
    createAndSendOffer(hostId);
  });

  // For host: Handle join requests
  socket.on("user-request-join", (userId, roomId) => {
    if (isRoomHost) {
      console.log("User requesting to join:", userId);
      createJoinRequest(userId, roomId);
    }
  });

  // Handle new user connections
  socket.on("user-connected", userId => {
    console.log("User connected:", userId);
    
    // Skip if this is about myself
    if (userId === myUserId) return;
    
    // If I'm the host and a new user connected after approval
    if (isRoomHost) {
      // Host waits for the offer from the joiner
      console.log("Host waiting for offer from new user:", userId);
      currentRemoteUserId = userId;
      
      if (!localPeerConnection) {
        createPeerConnection();
      }
    }
  });

  // Handle ICE candidates from other peers
  socket.on("ice-candidate", (senderUserId, candidate) => {
    console.log("Received ICE candidate from:", senderUserId);
    // Skip if this is from myself
    if (senderUserId === myUserId) return;
    
    handleReceivedIceCandidate(senderUserId, candidate);
  });

  // Handle SDP offers
  socket.on("offer", (senderUserId, targetId, offer) => {
    console.log("Received offer from:", senderUserId, "for", targetId);
    
    // Skip if this offer is not for me
    if (targetId !== myUserId && targetId !== undefined) return;
    
    // Skip if this is from myself
    if (senderUserId === myUserId) return;
    
    handleReceivedOffer(senderUserId, offer);
  });

  // Handle SDP answers
  socket.on("answer", (senderUserId, targetId, answer) => {
    console.log("Received answer from:", senderUserId, "for", targetId);
    
    // Skip if this answer is not for me
    if (targetId !== myUserId && targetId !== undefined) return;
    
    // Skip if this is from myself
    if (senderUserId === myUserId) return;
    
    handleReceivedAnswer(senderUserId, answer);
  });

  socket.on("join-rejected", (reason) => {
    alert("Your request to join was declined: " + (reason || "Host declined"));
    window.location.reload();
  });

  socket.on("user-disconnected", userId => {
    console.log("User disconnected:", userId);
    
    if (currentRemoteUserId === userId && remoteVideo.srcObject) {
      remoteVideo.srcObject.getTracks().forEach(track => track.stop());
      remoteVideo.srcObject = null;
      currentRemoteUserId = null;
    }

    // Clean up RTCPeerConnection if it exists
    if (localPeerConnection) {
      localPeerConnection.close();
      localPeerConnection = null;
    }
  });
}

// Create RTCPeerConnection
function createPeerConnection() {
  if (localPeerConnection) {
    console.log("Peer connection already exists, closing it first");
    localPeerConnection.close();
  }
  
  console.log("Creating new RTCPeerConnection");
  
  // Create new connection
  localPeerConnection = new RTCPeerConnection(iceServers);

  // Add local stream tracks to connection
  myStream.getTracks().forEach(track => {
    localPeerConnection.addTrack(track, myStream);
  });

  // Handle ICE candidates
  localPeerConnection.onicecandidate = event => {
    if (event.candidate) {
      // Send the ICE candidate to the remote peer via signaling server
      socket.emit("relay-ice-candidate", roomId, myUserId, currentRemoteUserId, event.candidate);
    }
  };

  // Handle connection state changes
  localPeerConnection.onconnectionstatechange = event => {
    console.log("Connection state:", localPeerConnection.connectionState);
    
    // Log audio state when connection is established
    if (localPeerConnection.connectionState === 'connected') {
      console.log("Connection established. Audio enabled:", audioEnabled);
      console.log("Audio tracks:", myStream.getAudioTracks().map(track => ({
        enabled: track.enabled,
        muted: track.muted,
        id: track.id
      })));
    }
  };

  // Handle incoming remote stream
  localPeerConnection.ontrack = event => {
    console.log("Received remote track");
    if (event.streams && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      // Ensure remote audio is not muted
      event.streams[0].getAudioTracks().forEach(track => {
        track.enabled = true;
      });
      remoteVideo.play().catch(e => console.error("Error playing remote video:", e));
    }
  };

  return localPeerConnection;
}

// Create and send SDP offer
async function createAndSendOffer(targetUserId) {
  try {
    if (!localPeerConnection) {
      createPeerConnection();
    }
    
    currentRemoteUserId = targetUserId;

    // Create offer
    const offer = await localPeerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    });
    
    // Set local description
    await localPeerConnection.setLocalDescription(offer);
    
    // Send offer to remote peer via signaling server
    socket.emit("relay-offer", roomId, myUserId, targetUserId, offer);
    console.log("Sent offer to:", targetUserId);
  } catch (error) {
    console.error("Error creating offer:", error);
  }
}

// Handle received ICE candidate
async function handleReceivedIceCandidate(senderUserId, candidate) {
  try {
    if (!localPeerConnection) {
      createPeerConnection();
    }
    
    // Don't add null candidates
    if (!candidate) return;
    
    await localPeerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    console.log("Added ICE candidate from:", senderUserId);
  } catch (error) {
    console.error("Error adding ICE candidate:", error);
  }
}

// Handle received SDP offer
async function handleReceivedOffer(senderUserId, offer) {
  try {
    if (!localPeerConnection) {
      createPeerConnection();
    }
    
    currentRemoteUserId = senderUserId;
    
    // Set remote description based on the offer
    await localPeerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    
    // Create answer
    const answer = await localPeerConnection.createAnswer();
    
    // Set local description
    await localPeerConnection.setLocalDescription(answer);
    
    // Send answer back to the sender
    socket.emit("relay-answer", roomId, myUserId, senderUserId, answer);
    console.log("Sent answer to:", senderUserId);
  } catch (error) {
    console.error("Error handling offer:", error);
  }
}

// Handle received SDP answer
async function handleReceivedAnswer(senderUserId, answer) {
  try {
    if (!localPeerConnection) {
      console.error("No peer connection exists");
      return;
    }
    
    // Set remote description based on the answer
    await localPeerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    currentRemoteUserId = senderUserId;
    console.log("Set remote description from answer by:", senderUserId);
  } catch (error) {
    console.error("Error handling answer:", error);
  }
}

// Create UI for join requests
function createJoinRequest(userId, roomId) {
  const requestElement = document.createElement("div");
  requestElement.className = "join-request";
  requestElement.innerHTML = `
    <p>User is requesting to join</p>
    <div class="request-buttons">
      <button class="accept-btn">Accept</button>
      <button class="reject-btn">Decline</button>
    </div>
  `;
  
  joinRequestsContainer.appendChild(requestElement);
  
  // Add event listeners for the buttons
  requestElement.querySelector(".accept-btn").addEventListener("click", () => {
    socket.emit("approve-join", roomId, userId);
    requestElement.remove();
  });
  
  requestElement.querySelector(".reject-btn").addEventListener("click", () => {
    socket.emit("reject-join", roomId, userId);
    requestElement.remove();
  });
}

// Utility to generate random room ID
function generateRoomId() {
  return Math.random().toString(36).substring(2, 12);
}

// Utility to generate random user ID
function generateUserId() {
  return 'user_' + Math.random().toString(36).substring(2, 10);
}

// Copy room ID function
function copyRoomId() {
  const roomNumberToCopy = isRoomHost ? roomNumberDisplay.textContent : activeRoomDisplay.textContent;
  navigator.clipboard.writeText(roomNumberToCopy)
    .then(() => {
      alert("Room ID copied to clipboard!");
    })
    .catch(err => {
      console.error("Could not copy text: ", err);
    });
}

// Audio Controls
muteAudioBtn.addEventListener('click', () => {
  audioEnabled = !audioEnabled;
  myStream.getAudioTracks().forEach(track => {
    track.enabled = audioEnabled;
  });
  muteAudioBtn.textContent = audioEnabled ? "Mute Audio" : "Unmute Audio";
  muteAudioBtn.classList.toggle("muted", !audioEnabled);
  console.log("Audio state changed to:", audioEnabled);
});

// Video Controls
muteVideoBtn.addEventListener('click', () => {
  videoEnabled = !videoEnabled;
  myStream.getVideoTracks().forEach(track => {
    track.enabled = videoEnabled;
  });
  muteVideoBtn.textContent = videoEnabled ? "Mute Video" : "Unmute Video";
  muteVideoBtn.classList.toggle("muted", !videoEnabled);
});

// Make copyRoomId globally available for the onclick handler
window.copyRoomId = copyRoomId;


