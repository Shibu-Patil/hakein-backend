import mongoose from 'mongoose';

let connected = false;

export function dbConfigured() {
  const url = process.env.DATABASE_URL || '';
  return !!url && !url.includes('<username>');
}

// Connect lazily; safe to call per request. No Prisma, no codegen — plain Mongoose.
export async function connectDb() {
  if (connected && mongoose.connection.readyState === 1) return mongoose.connection;
  if (!dbConfigured()) throw new Error('DATABASE_URL (Mongo Atlas) not configured. Set it in .env');
  await mongoose.connect(process.env.DATABASE_URL);
  connected = true;
  return mongoose.connection;
}

export function dbReady(res) {
  if (!dbConfigured()) {
    res.status(503).json({ error: 'DATABASE_URL (Mongo Atlas) not configured. Set it in .env' });
    return false;
  }
  return true;
}
