// mongoSession.js
import mongoose from 'mongoose';
import MongoStore from 'connect-mongo';
import session from 'express-session';

// ==========================
// 🔗 CONEXÃO COM O MONGO
// ==========================
export const connectDB = async (uri) => {
  if (!uri) throw new Error('❌ MONGO_URI não definida.');
  try {
    await mongoose.connect(uri);
    console.log('✅ Conectado ao MongoDB com sucesso!');
  } catch (err) {
    console.error('❌ Erro ao conectar ao MongoDB:', err);
  }
};

// ==========================
// 🔑 MODELO DE SESSÃO
// ==========================
const SessionSchema = new mongoose.Schema({
  _id: { type: String }, // usar "default" como id da sessão
  value: { type: mongoose.Schema.Types.Mixed }
}, { strict: false });

export const SessionModel = mongoose.model('Session', SessionSchema);

// ==========================
// 🔌 ARMAZENAMENTO DE SESSÃO PARA EXPRESS
// ==========================
export const mongoStore = (uri) => {
  return MongoStore.create({
    mongoUrl: uri,
    collectionName: 'sessions',
    ttl: 14 * 24 * 60 * 60 // 14 dias
  });
};

// ==========================
// 💡 USO NO EXPRESS
// ==========================
// app.use(session({
//   secret: 'chave-secreta-bot',
//   resave: false,
//   saveUninitialized: false,
//   store: mongoStore(process.env.MONGO_URI)
// }));