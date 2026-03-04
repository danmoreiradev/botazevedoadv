import mongoose from "mongoose";

/**
 * 🔗 Conecta ao MongoDB
 */
export const connectDB = async (uri) => {
  if (!uri) {
    throw new Error("❌ MONGO_URI não definida nas variáveis de ambiente.");
  }

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
    _id: {
      type: String,
      required: true
    },
    value: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    }
  },
  {
    versionKey: false,
    timestamps: true
  }
);

/**
 * 🗄 Model da Sessão
 * Collection: baileysauths (mongoose pluraliza automaticamente)
 */
export const SessionModel = mongoose.model("BaileysAuth", sessionSchema);