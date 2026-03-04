import mongoose from "mongoose";

/**
 * 🔗 Conecta ao MongoDB
 */
export const connectDB = async (uri) => {
  if (!uri) throw new Error("❌ MONGO_URI não definida.");

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
    _id: { type: String, required: true },          // ID da sessão, ex: "default"
    value: { type: mongoose.Schema.Types.Mixed },   // creds + keys
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
 * 🗄 Funções utilitárias para salvar e recuperar sessão
 */
export const saveSession = async (sessionId, auth) => {
  await SessionModel.findByIdAndUpdate(
    sessionId,
    { value: { creds: auth.creds, keys: auth.keys } },
    { upsert: true }
  );
};

export const loadSession = async (sessionId) => {
  const sessionData = await SessionModel.findById(sessionId);
  if (!sessionData?.value) return null;
  const value = fixBinary(sessionData.value);
  return { creds: value.creds, keys: value.keys };
};