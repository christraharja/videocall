const express = require('express');
const socketio = require('socket.io');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Redirect root to login page
app.get('/', (req, res) => {
  res.redirect('/login.html');
});

const server = app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});

const io = socketio(server);

// Track room hosts and users
const roomHosts = {};
const roomUsers = {};

io.on('connection', socket => {
  console.log('New connection:', socket.id);
  
  // Join room directly (for hosts)
  socket.on('join-room', (roomId, userId, role) => {
    console.log(`${role === 'host' ? 'Host' : 'User'} ${userId} joining room ${roomId}`);
    socket.join(roomId);
    
    // Store user in room
    if (!roomUsers[roomId]) {
      roomUsers[roomId] = [];
    }
    roomUsers[roomId].push(userId);
    
    // If this is the host, save their ID
    if (role === 'host') {
      roomHosts[roomId] = userId;
      console.log(`Host ${userId} created room ${roomId}`);
    } else {
      // Notify others in the room about the new user
      console.log(`User ${userId} joined room ${roomId}`);
      socket.to(roomId).emit('user-connected', userId);
    }

    socket.roomId = roomId;
    socket.userId = userId;
    socket.isHost = (role === 'host');

    socket.on('disconnect', () => {
      console.log(`User ${userId} disconnected from room ${roomId}`);
      
      // Remove user from room
      if (roomUsers[roomId]) {
        roomUsers[roomId] = roomUsers[roomId].filter(id => id !== userId);
        
        // If room is empty, clean up
        if (roomUsers[roomId].length === 0) {
          delete roomUsers[roomId];
        }
      }
      
      // If host disconnects, clean up
      if (role === 'host' && roomHosts[roomId] === userId) {
        delete roomHosts[roomId];
      }
      
      // Notify others in the room
      socket.to(roomId).emit('user-disconnected', userId);
    });
  });
  
  // Request to join room (for joiners)
  socket.on('request-join', (roomId, userId) => {
    console.log(`User ${userId} requesting to join room ${roomId}`);
    
    // Check if room exists and has a host
    if (roomHosts[roomId]) {
      // Temporarily join room to receive host messages
      socket.join(roomId);
      socket.roomId = roomId;
      socket.userId = userId;
      
      // Send join request to the host
      socket.to(roomId).emit('user-request-join', userId, roomId);
    } else {
      // Room doesn't exist or no host
      console.log(`User ${userId} tried to join non-existent room ${roomId}`);
      socket.emit('join-rejected', 'Room does not exist');
    }
  });
  
  // Host approves join request
  socket.on('approve-join', (roomId, userId) => {
    console.log(`Host approved user ${userId} to join room ${roomId}`);
    
    // Add user to room users list
    if (!roomUsers[roomId]) {
      roomUsers[roomId] = [];
    }
    if (!roomUsers[roomId].includes(userId)) {
      roomUsers[roomId].push(userId);
    }
    
    const hostId = roomHosts[roomId];
    
    // Notify the joiner they've been approved (with host ID)
    io.to(roomId).emit('join-approved', userId, hostId);
    
    // After a short delay, notify everyone about the new user
    setTimeout(() => {
      io.to(roomId).emit('user-connected', userId);
    }, 500);
  });
  
  // Host rejects join request
  socket.on('reject-join', (roomId, userId) => {
    console.log(`Host rejected user ${userId} from room ${roomId}`);
    io.to(roomId).emit('join-rejected', 'Host declined your request');
  });

  // Relay ICE candidates between peers
  socket.on('relay-ice-candidate', (roomId, senderId, targetId, candidate) => {
    console.log(`Relaying ICE candidate from ${senderId} to ${targetId} in room ${roomId}`);
    socket.to(roomId).emit('ice-candidate', senderId, candidate);
  });

  // Relay SDP offers
  socket.on('relay-offer', (roomId, senderId, targetId, offer) => {
    console.log(`Relaying offer from ${senderId} to ${targetId} in room ${roomId}`);
    io.to(roomId).emit('offer', senderId, targetId, offer);
  });

  // Relay SDP answers
  socket.on('relay-answer', (roomId, senderId, targetId, answer) => {
    console.log(`Relaying answer from ${senderId} to ${targetId} in room ${roomId}`);
    io.to(roomId).emit('answer', senderId, targetId, answer);
  });
});