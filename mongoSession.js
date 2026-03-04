import mongoose from "mongoose";

/**
 * 🔗 Conecta ao MongoDB
 */
export const connectDB = async (uri) => {
  if (!uri) throw new Error("❌ MONGO_URI não definida nas variáveis de ambiente.");

  try {
    // 🔹 Remove options antigas (Mongoose >=7 já trata automaticamente)
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
    value: { type: mongoose.Schema.Types.Mixed },   // credenciais + keys
  },
  { versionKey: false, timestamps: true }
);

export const SessionModel = mongoose.model("BaileysAuth", sessionSchema);

/**
 * 🔧 Função para converter Binary do Mongo para Buffer real
 */
function fixBinary(obj) {
  if (!obj) return obj;
  if (obj?._bsontype === "Binary" && obj.buffer) return Buffer.from(obj.buffer);
  if (obj?.type === "Buffer" && Array.isArray(obj.data)) return Buffer.from(obj.data);
  if (Array.isArray(obj)) return obj.map(fixBinary);
  if (typeof obj === "object") {
    for (const key in obj) obj[key] = fixBinary(obj[key]);
  }
  return obj;
}

/**
 * 🗄 MongoStore otimizado para Baileys
 */
export const mongoStore = {
  authState: {},

  // Retorna objetos armazenados
  async get(type, ids) {
    const docs = await SessionModel.find({ _id: { $in: ids } });
    const result = {};
    docs.forEach((d) => {
      result[d._id] = fixBinary(d.value);  // Corrige Binary -> Buffer
    });
    return result;
  },

  // Salva ou atualiza
  async set(id, value) {
    if (!value) return;
    await SessionModel.updateOne(
      { _id: id },
      { $set: { value } },
      { upsert: true }
    );
  },

  // Deleta sessão
  async delete(id) {
    await SessionModel.deleteOne({ _id: id });
  },

  // Retorna todas as sessões
  async all() {
    const docs = await SessionModel.find();
    const result = {};
    docs.forEach((d) => {
      result[d._id] = fixBinary(d.value);
    });
    return result;
  },
};