const express = require('express');
const cors = require('cors');
const http = require('http');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const { createRoom } = require('./rooms');
const socketHandler = require('./socketHandler');

const app = express();
const port = process.env.PORT || 5000;

// Enable Helmet middleware for secure HTTP headers
app.use(helmet());

// Custom Content Security Policy (CSP) directive configurations for WebSockets & WebRTC
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: [
        "'self'",
        "ws://localhost:5000",
        "http://localhost:5000",
        "ws://127.0.0.1:5000",
        "http://127.0.0.1:5000",
        "http://localhost:5000/peer",
        "ws://localhost:5000/peer",
        "http://127.0.0.1:5000/peer",
        "ws://127.0.0.1:5000/peer"
      ],
      mediaSrc: ["'self'", "blob:", "mediastream:"], // blob: and mediastream: are essential for WebRTC camera feeds
      imgSrc: ["'self'", "data:", "blob:"]
    }
  })
);

// Whitelist origins for CORS (restrict from wildcard *)
const allowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  process.env.FRONTEND_URL
].filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    
    const isLocal = origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:');
    
    // Normalize trailing slashes and spaces for robust checking
    const cleanOrigin = origin.trim().replace(/\/$/, '');
    const cleanAllowedOrigins = allowedOrigins.map(o => o.trim().replace(/\/$/, ''));
    
    const isAllowedProduction = process.env.FRONTEND_URL 
      ? cleanAllowedOrigins.includes(cleanOrigin)
      : true;

    if (isLocal || isAllowedProduction) {
      callback(null, true);
    } else {
      console.warn(`[CORS Blocked] Origin: "${origin}" is not in the allowed whitelist:`, cleanAllowedOrigins);
      callback(null, false);
    }
  },
  methods: ['GET', 'POST'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// Basic health check route
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'WindWatch backend is running.' });
});

// Rate limiting for room creation to protect against spam / DDoS
const createRoomLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15,
  message: { error: 'Çok fazla oda oluşturdunuz. Lütfen 15 dakika sonra tekrar deneyin.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// API: Create a new room
app.post('/create-room', createRoomLimiter, (req, res) => {
  try {
    const { password } = req.body || {};
    const roomId = createRoom(password);
    console.log(`Created room: ${roomId} (Password protected: ${password ? 'Yes' : 'No'})`);
    res.status(201).json({ roomId });
  } catch (error) {
    console.error('Error creating room:', error);
    res.status(500).json({ error: 'Failed to create room.' });
  }
});

// Create the HTTP server
const server = http.createServer(app);

// Initialize Socket.io with CORS configured
const io = new Server(server, {
  cors: corsOptions
});

// Attach Socket.io handlers
socketHandler(io);

// Initialize ExpressPeerServer
const peerServer = ExpressPeerServer(server, {
  debug: process.env.NODE_ENV !== 'production',
  path: '/' // Runs under the '/peer' route namespace (i.e., /peer/peerjs/...)
});

// Mount PeerServer middleware
app.use('/peer', peerServer);

// Start the server
server.listen(port, () => {
  console.log(`===============================================`);
  console.log(`🚀 WindWatch server running on port ${port}`);
  console.log(`📡 Socket.io connected and ready`);
  console.log(`🌐 PeerJS server listening at http://localhost:${port}/peer`);
  console.log(`===============================================`);
});

// Listen to PeerJS Server connection events for debugging
peerServer.on('connection', (client) => {
  console.log(`PeerJS client connected: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`PeerJS client disconnected: ${client.getId()}`);
});
