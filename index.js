const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

let sock;
let qrCodeData = '';
let isConnected = false;

// ✅ URLs dos webhooks N8n
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';

// ✅ Função SIMPLES: só envia para N8n
async function sendToN8n(messageData) {
  if (!N8N_WEBHOOK_URL) {
    console.log('⚠️ N8N_WEBHOOK_URL não configurado');
    return;
  }

  try {
    const response = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(messageData)
    });

    if (response.ok) {
      const direction = messageData.fromMe ? '📤 Enviada' : '📥 Recebida';
      console.log(`✅ ${direction} → N8n: ${messageData.pushName} - ${messageData.text?.substring(0, 40)}...`);
    } else {
      console.log(`❌ Erro webhook N8n: ${response.status}`);
    }
  } catch (error) {
    console.log(`❌ Erro ao enviar para N8n: ${error.message}`);
  }
}

// ✅ Buscar histórico completo de uma conversa
async function getConversationHistory(jid, limit = 20) {
  if (!sock) return [];
  
  try {
    console.log(`📚 Buscando histórico de ${jid}...`);
    const messages = await sock.fetchMessagesFromWA(jid, limit);
    
    const history = [];
    
    for (const msg of messages) {
      const messageData = {
        id: msg.key.id,
        from: msg.key.remoteJid,
        fromNumber: msg.key.remoteJid?.split('@')[0],
        text: extractMessageText(msg),
        timestamp: new Date(msg.messageTimestamp * 1000).toISOString(),
        pushName: msg.pushName || 'Sem nome',
        fromMe: Boolean(msg.key.fromMe),
        messageTimestamp: msg.messageTimestamp,
        isHistoric: true
      };
      
      history.push(messageData);
    }
    
    // Ordenar por timestamp (mais antigas primeiro)
    history.sort((a, b) => a.messageTimestamp - b.messageTimestamp);
    
    console.log(`📖 ${history.length} mensagens históricas encontradas`);
    return history;
    
  } catch (error) {
    console.log(`❌ Erro ao buscar histórico: ${error.message}`);
    return [];
  }
}

function extractMessageText(message) {
  if (message.message?.conversation) return message.message.conversation;
  if (message.message?.extendedTextMessage?.text) return message.message.extendedTextMessage.text;
  if (message.message?.imageMessage?.caption) return `[Imagem] ${message.message.imageMessage.caption}`;
  if (message.message?.videoMessage?.caption) return `[Vídeo] ${message.message.videoMessage.caption}`;
  if (message.message?.audioMessage) return '[Áudio]';
  if (message.message?.documentMessage) return `[Documento] ${message.message.documentMessage.fileName || ''}`;
  if (message.message?.stickerMessage) return '[Sticker]';
  return '[Mídia]';
}

// Conectar WhatsApp
async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ['N8n CRM', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        try {
          qrCodeData = await QRCode.toDataURL(qr);
          console.log('📱 QR Code gerado!');
        } catch (err) {
          console.error('Erro QR:', err);
        }
      }
      
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('🔌 Conexão fechada. Reconectando...', shouldReconnect);
        
        if (shouldReconnect) {
          setTimeout(connectToWhatsApp, 3000);
        }
        isConnected = false;
      } else if (connection === 'open') {
        console.log('✅ WhatsApp conectado! Webhook N8n ativo.');
        isConnected = true;
        qrCodeData = '';
      }
    });

    // ✅ CAPTURAR e ENVIAR IMEDIATAMENTE para N8n
    sock.ev.on('messages.upsert', async (m) => {
      try {
        for (const message of m.messages) {
          
          const messageData = {
            id: message.key.id,
            from: message.key.remoteJid,
            fromNumber: message.key.remoteJid?.split('@')[0],
            text: extractMessageText(message),
            timestamp: new Date().toISOString(),
            pushName: message.pushName || (message.key.fromMe ? 'Você' : 'Sem nome'),
            fromMe: Boolean(message.key.fromMe),
            messageTimestamp: message.messageTimestamp,
            type: 'message'
          };

          // ✅ Validar e enviar para N8n
          if (messageData.fromNumber && messageData.fromNumber.length >= 10) {
            await sendToN8n(messageData);
          }
        }
      } catch (error) {
        console.error('❌ Erro ao processar mensagens:', error);
      }
    });

  } catch (error) {
    console.error('❌ Erro na conexão:', error);
    setTimeout(connectToWhatsApp, 5000);
  }
}

// 🔗 ROTAS DA API

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    connected: isConnected,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/', (req, res) => {
  res.json({
    message: '🚀 WhatsApp → N8n CRM Bridge',
    connected: isConnected,
    webhookConfigured: !!N8N_WEBHOOK_URL,
    uptime: Math.round(process.uptime()),
    endpoints: {
      '/qr': 'QR Code para conectar',
      '/status': 'Status da conexão',
      '/history/:phone': 'Buscar histórico de conversa',
      '/send-message': 'Enviar mensagem',
      '/test-webhook': 'Testar webhook N8n'
    }
  });
});

app.get('/qr', (req, res) => {
  if (qrCodeData) {
    res.send(`
      <html>
        <head><title>WhatsApp N8n Bridge</title>
        <style>body{font-family:Arial;text-align:center;padding:20px;background:#f5f5f5}
        .container{background:white;padding:30px;border-radius:10px;max-width:500px;margin:0 auto}
        img{max-width:300px}</style></head>
        <body>
          <div class="container">
            <h1>📱 WhatsApp → N8n CRM</h1>
            <p>Escaneie para conectar:</p>
            <img src="${qrCodeData}" alt="QR Code">
            <div style="margin:20px">
              <button onclick="window.location.reload()">🔄 Atualizar</button>
            </div>
            <p><small>Cada mensagem será enviada automaticamente para N8n</small></p>
          </div>
        </body>
      </html>
    `);
  } else if (isConnected) {
    res.send(`
      <html>
        <body style="font-family:Arial;text-align:center;padding:50px">
          <h1>✅ WhatsApp Conectado!</h1>
          <p>🔗 Webhook N8n: ${N8N_WEBHOOK_URL ? 'Configurado' : 'NÃO configurado'}</p>
          <p>Todas as mensagens serão enviadas automaticamente para o N8n</p>
        </body>
      </html>
    `);
  } else {
    res.send(`<html><body style="text-align:center;padding:50px"><h1>⏳ Conectando...</h1></body></html>`);
  }
});

app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    hasQR: !!qrCodeData,
    webhookConfigured: !!N8N_WEBHOOK_URL,
    webhookUrl: N8N_WEBHOOK_URL ? N8N_WEBHOOK_URL.substring(0, 50) + '...' : null,
    uptime: process.uptime()
  });
});

// ✅ Endpoint para buscar histórico completo de uma conversa
app.get('/history/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    const limit = parseInt(req.query.limit) || 20;
    
    if (!isConnected) {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }
    
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    const history = await getConversationHistory(jid, limit);
    
    res.json({
      phone: phone,
      totalMessages: history.length,
      history: history,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ Enviar mensagem
app.post('/send-message', async (req, res) => {
  try {
    const { number, message } = req.body;
    
    if (!number || !message) {
      return res.status(400).json({ error: 'Número e mensagem obrigatórios' });
    }
    
    if (!isConnected) {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }
    
    const cleanNumber = number.replace(/\D/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;
    
    // Enviar mensagem
    const result = await sock.sendMessage(jid, { text: message });
    
    // ✅ Criar dados da mensagem enviada para N8n
    const messageData = {
      id: result.key.id,
      from: jid,
      fromNumber: cleanNumber,
      text: message,
      timestamp: new Date().toISOString(),
      pushName: 'Você',
      fromMe: true,
      type: 'sent_message'
    };
    
    // Enviar para N8n também
    await sendToN8n(messageData);
    
    res.json({ 
      success: true, 
      messageId: result.key.id,
      sentToN8n: !!N8N_WEBHOOK_URL
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ Testar webhook N8n
app.post('/test-webhook', async (req, res) => {
  const testData = {
    type: 'test',
    fromNumber: '5511999999999',
    pushName: 'Teste',
    text: 'Mensagem de teste do webhook',
    timestamp: new Date().toISOString(),
    fromMe: false
  };
  
  try {
    await sendToN8n(testData);
    res.json({ success: true, message: 'Teste enviado para N8n' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp → N8n Bridge - Porta ${PORT}`);
  console.log(`🎯 Modo: Webhook direto para N8n`);
  console.log(`🔗 Webhook N8n: ${N8N_WEBHOOK_URL || 'NÃO CONFIGURADO'}`);
  
  connectToWhatsApp();
});
