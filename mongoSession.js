import mongoose from "mongoose";
import { makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';

/**
 * 🔗 Conecta ao MongoDB
 */
export const connectDB = async (uri) => {
  if (!uri) throw new Error("❌ MONGO_URI não definida nas variáveis de ambiente.");

  try {
    await mongoose.connect(uri);
    console.log("✅ Conectado ao MongoDB com sucesso!");
  } catch (error) {
    console.error("❌ Erro ao conectar no MongoDB:", error);
    process.exit(1);
  }
};

/**
 * 📄 Schema da Sessão Baileys
 */
const sessionSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    value: { type: mongoose.Schema.Types.Mixed },
  },
  { versionKey: false, timestamps: true }
);

export const SessionModel = mongoose.model("BaileysAuth", sessionSchema);

/**
 * 🔧 Converte Binary do Mongo para Buffer real
 */
function fixBinary(obj) {
  if (!obj) return obj;
  if (obj?._bsontype === "Binary" && obj.buffer) return Buffer.from(obj.buffer);
  if (obj?.type === "Buffer" && Array.isArray(obj.data)) return Buffer.from(obj.data);
  if (Array.isArray(obj)) return obj.map(fixBinary);
  if (typeof obj === "object") for (const key in obj) obj[key] = fixBinary(obj[key]);
  return obj;
}

/**
 * 🗄 MongoStore para Baileys
 */
export const mongoStore = makeCacheableSignalKeyStore({
  // 🔹 Retorna todos os keys de um tipo
  async get(type, ids) {
    if (!Array.isArray(ids)) ids = [ids];
    const docs = await SessionModel.find({ _id: { $in: ids } });
    const result = {};
    docs.forEach(d => {
      result[d._id] = fixBinary(d.value?.keys || {});
    });
    return result;
  },

  // 🔹 Salva/atualiza keys
  async set(type, id, data) {
    const sessionId = id || "default";
    const existing = await SessionModel.findById(sessionId);
    if (existing) {
      existing.value = existing.value || {};
      existing.value.keys = { ...(existing.value.keys || {}), ...data };
      await existing.save();
    } else {
      await SessionModel.create({ _id: sessionId, value: { keys: data, creds: {} } });
    }
  },

  // 🔹 Remove keys
  async remove(type, id) {
    const sessionId = id || "default";
    const existing = await SessionModel.findById(sessionId);
    if (existing && existing.value?.keys) {
      delete existing.value.keys;
      await existing.save();
    }
  },

  // 🔹 Retorna todas as sessões
  async all() {
    const docs = await SessionModel.find();
    const result = {};
    docs.forEach(d => {
      result[d._id] = fixBinary(d.value?.keys || {});
    });
    return result;
  }
});