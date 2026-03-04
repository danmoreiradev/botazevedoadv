// src/models/WhatsAppSession.js
import mongoose from 'mongoose';

const WhatsAppSessionSchema = new mongoose.Schema({
  _id: { type: String, default: 'wa-session' }, // sempre usamos o mesmo ID
  creds: { type: Object, required: true }       // credenciais do Baileys
}, { timestamps: true });

export const WhatsAppSession = mongoose.model('WhatsAppSession', WhatsAppSessionSchema);