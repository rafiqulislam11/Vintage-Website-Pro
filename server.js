require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const { seedDemoUser } = require('./database/seed');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// Security & Parsing Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({
  origin: true,
  credentials: true
}));

// Basic Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Seed demo user on startup (Rafiqul Islam / freelancerrafiq55@gmail.com)
try {
  seedDemoUser();
} catch (err) {
  console.error('Failed to seed demo user:', err);
}

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);

// Serve static frontend files
app.use(express.static(path.resolve(__dirname)));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// SPA fallback middleware
app.use((req, res) => {
  res.sendFile(path.resolve(__dirname, 'index.html'));
});

// Start Server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 Vintage Paper Studio Pro SaaS Server running on:`);
    console.log(`   http://localhost:${PORT}`);
    console.log(`====================================================`);
  });
}

module.exports = app;
