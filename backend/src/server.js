const express = require('express');
const cors = require('cors');
const http = require('node:http');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const { createRoom } = require('./rooms');
const socketHandler = require('./socketHandler');

function createServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  const origins = (process.env.FRONTEND_URL || '').split(',').map(origin => origin.trim().replace(/\/$/, '')).filter(Boolean);
  const corsOptions = {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      let local = false;
      try { local = ['localhost', '127.0.0.1'].includes(new URL(origin).hostname); } catch { /* invalid origin */ }
      callback(null, origins.includes(origin) || (process.env.NODE_ENV !== 'production' && local));
    },
    methods: ['GET', 'POST']
  };
  app.use(cors(corsOptions));
  app.use(express.json({ limit: '16kb' }));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  const roomLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 30,
    message: { error: 'Çok fazla oda oluşturdunuz. Lütfen daha sonra tekrar deneyin.' },
    standardHeaders: 'draft-8', legacyHeaders: false
  });
  app.post('/create-room', roomLimiter, (req, res) => {
    const password = req.body?.password;
    if (password != null && (typeof password !== 'string' || password.length > 100)) {
      return res.status(400).json({ error: 'Şifre en fazla 100 karakter olmalıdır.' });
    }
    res.status(201).json({ roomId: createRoom(password || null) });
  });
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: corsOptions,
    maxHttpBufferSize: 256 * 1024,
    allowRequest: (req, callback) => corsOptions.origin(req.headers.origin, (_error, allowed) => callback(null, !!allowed))
  });
  socketHandler(io);
  return { app, server, io };
}

if (require.main === module) {
  const { server, io } = createServer();
  const port = process.env.PORT || 5000;
  server.listen(port, () => console.log(`WindWatch sunucusu ${port} portunda hazır.`));
  const stop = () => io.close(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

module.exports = { createServer };
