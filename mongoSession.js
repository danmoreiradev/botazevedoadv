import mongoose from "mongoose";

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
    value: { type: mongoose.Schema.Types.Mixed, required: true }
  },
  { versionKey: false, timestamps: true }
);

// 🔑 Exportando também o modelo
export const SessionModel = mongoose.model("BaileysAuth", sessionSchema);

/**
 * 🗄 MongoStore para Baileys
 */
export const mongoStore = {
  authState: {},

  async get(type, ids) {
    const docs = await SessionModel.find({ _id: { $in: ids } });
    const result = {};
    docs.forEach(d => (result[d._id] = d.value));
    return result;
  },

  async set(id, value) {
    await SessionModel.updateOne(
      { _id: id },
      { $set: { value } },
      { upsert: true }
    );
  },

  async delete(id) {
    await SessionModel.deleteOne({ _id: id });
  },

  async all() {
    const docs = await SessionModel.find();
    const result = {};
    docs.forEach(d => (result[d._id] = d.value));
    return result;
  },
};