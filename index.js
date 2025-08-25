const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const cors = require('cors');
const cron = require('node-cron');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

let sock;
let qrCodeData = '';
let isConnected = false;
let allMessages = [];
let contacts = new Map();
let myJid = ''; // ✅ Armazenar seu JID para identificar mensagens suas

// Keep-alive
function keepAlive() {
  if (process.env.RENDER_SERVICE_URL) {
    setInterval(() => {
      fetch(process.env.RENDER_SERVICE_URL + '/health').catch(() => {});
    }, 14 * 60 * 1000);
  }
}

// ✅ Função melhorada para salvar mensagens
function saveMessage(messageData, forceFromMe = false) {
  // Verificar duplicata
  const exists = allMessages.some(msg => 
    msg.id === messageData.id || 
    (msg.text === messageData.text && 
     msg.fromNumber === messageData.fromNumber && 
     Math.abs(new Date(msg.timestamp) - new Date(messageData.timestamp)) < 5000)
  );
  
  if (exists && !forceFromMe) return false;

  // ✅ Se forçado como minha mensagem, marcar como tal
  if (forceFromMe) {
    messageData.fromMe = true;
    messageData.pushName = 'Você';
  }

  // ✅ Verificar se é mensagem sua baseado no JID
  if (myJid && messageData.from && messageData.from.includes(myJid.split('@')[0])) {
    messageData.fromMe = true;
    messageData.pushName = 'Você';
  }

  allMessages.push({
    ...messageData,
    savedAt: new Date().toISOString()
  });

  // Limitar mensagens
  if (allMessages.length > 1000) {
    allMessages = allMessages.slice(-1000);
  }

  // Atualizar contato
  if (messageData.fromNumber) {
    const existingContact = contacts.get(messageData.fromNumber) || {};
    contacts.set(messageData.fromNumber, {
      ...existingContact,
      name: messageData.fromMe ? 'Você' : (messageData.pushName || existingContact.name || 'Sem nome'),
      phone: messageData.fromNumber,
      lastMessage: messageData.text,
      lastSeen: messageData.timestamp,
      messageCount: (existingContact.messageCount || 0) + 1
    });
  }

  const direction = messageData.fromMe ? '📤 VOCÊ' : '📥 RECEBIDA';
  const contact = messageData.fromMe ? messageData.fromNumber : messageData.pushName;
  console.log(`💾 ${direction} → ${contact}: ${messageData.text?.substring(0, 40)}...`);
  console.log(`📊 Total: ${allMessages.length} msgs (${allMessages.filter(m => m.fromMe).length} suas, ${allMessages.filter(m => !m.fromMe).length} recebidas)`);
  
  return true;
}

// Conectar ao WhatsApp
async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ['CRM System', 'Chrome', '1.0.0'],
      syncFullHistory: false
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
        myJid = '';
      } else if (connection === 'open') {
        console.log('✅ WhatsApp conectado!');
        isConnected = true;
        qrCodeData = '';
        
        // ✅ Obter seu JID
        try {
          myJid = sock.user?.id || '';
          console.log(`👤 Seu JID: ${myJid}`);
        } catch (e) {
          console.log('⚠️ Não foi possível obter JID');
        }
        
        setTimeout(loadExistingChats, 3000);
      }
    });

    // ✅ Capturar TODAS as mensagens
    sock.ev.on('messages.upsert', async (m) => {
      try {
        for (const message of m.messages) {
          
          const messageData = {
            id: message.key.id,
            from: message.key.remoteJid,
            fromNumber: message.key.remoteJid?.split('@')[0],
            text: extractMessageText(message),
            timestamp: new Date().toISOString(),
            pushName: message.pushName || 'Sem nome',
            fromMe: Boolean(message.key.fromMe),
            messageTimestamp: message.messageTimestamp,
            type: getMessageType(message)
          };

          // ✅ Validação mais rigorosa para identificar mensagens suas
          if (messageData.fromNumber && messageData.fromNumber.length >= 10) {
            
            // ✅ Verificações adicionais para identificar se é sua mensagem
            const isFromMe = message.key.fromMe || 
                           (myJid && message.key.participant === myJid) ||
                           (myJid && messageData.from === myJid);
            
            if (isFromMe) {
              messageData.fromMe = true;
              messageData.pushName = 'Você';
            }
            
            saveMessage(messageData);
          }
        }
      } catch (error) {
        console.error('❌ Erro ao processar mensagens:', error);
      }
    });

    // ✅ Capturar confirmações de entrega (suas mensagens)
    sock.ev.on('message-receipt.update', (updates) => {
      console.log('📧 Recibos de mensagem:', updates.length);
    });

  } catch (error) {
    console.error('❌ Erro na conexão:', error);
    setTimeout(connectToWhatsApp, 5000);
  }
}

// Extrair texto da mensagem
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

function getMessageType(message) {
  if (message.message?.conversation || message.message?.extendedTextMessage) return 'text';
  if (message.message?.imageMessage) return 'image';
  if (message.message?.videoMessage) return 'video';
  if (message.message?.audioMessage) return 'audio';
  if (message.message?.documentMessage) return 'document';
  return 'unknown';
}

async function loadExistingChats() {
  if (!sock) return;
  
  try {
    console.log('📚 Carregando conversas...');
    const chats = await sock.getChats();
    console.log(`💬 ${chats.length} conversas encontradas`);
    
    let loadedCount = 0;
    
    for (const chat of chats.slice(0, 10)) {
      if (chat.id.endsWith('@s.whatsapp.net')) {
        try {
          const messages = await sock.fetchMessagesFromWA(chat.id, 3);
          
          for (const msg of messages) {
            const messageData = {
              id: msg.key.id + '_historic',
              from: msg.key.remoteJid,
              fromNumber: msg.key.remoteJid?.split('@')[0],
              text: extractMessageText(msg),
              timestamp: new Date(msg.messageTimestamp * 1000).toISOString(),
              pushName: msg.pushName || chat.name || 'Sem nome',
              fromMe: Boolean(msg.key.fromMe),
              messageTimestamp: msg.messageTimestamp,
              isHistoric: true
            };

            if (messageData.fromNumber) {
              saveMessage(messageData);
              loadedCount++;
            }
          }
          
          await new Promise(resolve => setTimeout(resolve, 500));
          
        } catch (error) {
          console.log(`⚠️ Erro conversa: ${error.message}`);
        }
      }
    }
    
    console.log(`✅ ${loadedCount} mensagens históricas carregadas`);
    
  } catch (error) {
    console.error('❌ Erro ao carregar conversas:', error);
  }
}

// ✅ ROTAS DA API

app.get('/health', (req, res) => {
  const sentCount = allMessages.filter(msg => msg.fromMe).length;
  const receivedCount = allMessages.filter(msg => !msg.fromMe).length;
  
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    totalMessages: allMessages.length,
    sentByMe: sentCount,
    received: receivedCount,
    totalContacts: contacts.size,
    connected: isConnected,
    myJid: myJid
  });
});

app.get('/', (req, res) => {
  const sentCount = allMessages.filter(msg => msg.fromMe).length;
  const receivedCount = allMessages.filter(msg => !msg.fromMe).length;
  
  res.json({
    message: '🚀 WhatsApp CRM API v2.2 - Captura Forçada',
    connected: isConnected,
    myJid: myJid,
    stats: {
      totalMessages: allMessages.length,
      sentByMe: sentCount,
      received: receivedCount,
      totalContacts: contacts.size,
      uptime: Math.round(process.uptime())
    },
    endpoints: {
      '/qr': 'QR Code',
      '/status': 'Status detalhado',
      '/messages': 'Todas as mensagens',
      '/debug': '🆕 Debug de captura',
      '/send-message': 'Enviar mensagem'
    }
  });
});

app.get('/qr', (req, res) => {
  if (qrCodeData) {
    res.send(`
      <html>
        <head><title>WhatsApp CRM v2.2</title>
        <style>body{font-family:Arial;text-align:center;padding:20px;background:#f5f5f5}
        .container{background:white;padding:30px;border-radius:10px;max-width:500px;margin:0 auto}
        img{max-width:300px;border:1px solid #ddd}
        button{background:#25D366;color:white;border:none;padding:10px 20px;border-radius:5px;cursor:pointer}</style>
        </head>
        <body>
          <div class="container">
            <h1>📱 WhatsApp CRM v2.2</h1>
            <p><strong>Captura Garantida:</strong> Suas mensagens + recebidas</p>
            <img src="${qrCodeData}" alt="QR Code">
            <div style="margin:20px">
              <button onclick="window.location.reload()">🔄 Atualizar</button>
            </div>
          </div>
        </body>
      </html>
    `);
  } else if (isConnected) {
    const sentCount = allMessages.filter(msg => msg.fromMe).length;
    const receivedCount = allMessages.filter(msg => !msg.fromMe).length;
    
    res.send(`
      <html>
        <body style="font-family:Arial;text-align:center;padding:50px;background:#f5f5f5">
          <div style="background:white;padding:30px;border-radius:10px;max-width:600px;margin:0 auto">
            <h1>✅ WhatsApp Conectado v2.2</h1>
            <div style="display:flex;justify-content:space-around;margin:20px">
              <div><h3>📤 ${sentCount}</h3><p>Suas Mensagens</p></div>
              <div><h3>📥 ${receivedCount}</h3><p>Recebidas</p></div>
              <div><h3>👥 ${contacts.size}</h3><p>Contatos</p></div>
            </div>
            <p><small>JID: ${myJid}</small></p>
            <div style="margin:20px">
              <a href="/messages?format=html" style="margin:10px;padding:10px 20px;background:#25D366;color:white;text-decoration:none;border-radius:5px">📱 Ver Mensagens</a>
              <a href="/debug" style="margin:10px;padding:10px 20px;background:#ff6b6b;color:white;text-decoration:none;border-radius:5px">🔧 Debug</a>
            </div>
          </div>
        </body>
      </html>
    `);
  } else {
    res.send(`
      <html><body style="font-family:Arial;text-align:center;padding:50px">
        <h1>⏳ Conectando v2.2...</h1>
        <button onclick="window.location.reload()">🔄 Atualizar</button>
      </body></html>
    `);
  }
});

// ✅ Debug endpoint
app.get('/debug', (req, res) => {
  const sentMessages = allMessages.filter(msg => msg.fromMe);
  const receivedMessages = allMessages.filter(msg => !msg.fromMe);
  const last10 = allMessages.slice(-10);
  
  res.json({
    debug: 'WhatsApp CRM v2.2',
    connected: isConnected,
    myJid: myJid,
    totals: {
      allMessages: allMessages.length,
      sentByMe: sentMessages.length,
      received: receivedMessages.length,
      contacts: contacts.size
    },
    lastMessages: last10.map(msg => ({
      id: msg.id,
      fromMe: msg.fromMe,
      fromNumber: msg.fromNumber,
      pushName: msg.pushName,
      text: msg.text?.substring(0, 50) + '...',
      timestamp: msg.timestamp
    })),
    sentMessages: sentMessages.slice(-5).map(msg => ({
      to: msg.fromNumber,
      text: msg.text?.substring(0, 30) + '...',
      timestamp: msg.timestamp
    }))
  });
});

app.get('/status', (req, res) => {
  const sentCount = allMessages.filter(msg => msg.fromMe).length;
  const receivedCount = allMessages.filter(msg => !msg.fromMe).length;
  
  res.json({
    connected: isConnected,
    hasQR: !!qrCodeData,
    myJid: myJid,
    totalMessages: allMessages.length,
    sentByMe: sentCount,
    received: receivedCount,
    totalContacts: contacts.size,
    uptime: process.uptime()
  });
});

app.get('/messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const phone = req.query.phone;
  const format = req.query.format || 'json';
  const fromMe = req.query.fromMe === 'true';
  
  let filteredMessages = [...allMessages];
  
  if (phone) {
    filteredMessages = filteredMessages.filter(msg => msg.fromNumber === phone);
  }
  if (fromMe) {
    filteredMessages = filteredMessages.filter(msg => msg.fromMe);
  }
  
  filteredMessages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const result = filteredMessages.slice(0, limit);
  
  if (format === 'html') {
    const sentCount = allMessages.filter(msg => msg.fromMe).length;
    const receivedCount = allMessages.filter(msg => !msg.fromMe).length;
    
    let html = `
      <html>
        <head><title>Mensagens WhatsApp CRM v2.2</title>
        <style>body{font-family:Arial;padding:20px;background:#f5f5f5}
        .message{background:white;padding:15px;margin:10px 0;border-radius:8px;border-left:4px solid #25D366}
        .from-me{border-left-color:#1f8ef1;background:#f0f8ff}
        .stats{background:white;padding:15px;border-radius:8px;margin-bottom:20px}</style>
        </head>
        <body>
          <div class="stats">
            <h1>📱 WhatsApp CRM v2.2 - Mensagens</h1>
            <p>📤 <strong>${sentCount}</strong> enviadas por você | 
               📥 <strong>${receivedCount}</strong> recebidas | 
               📊 <strong>${allMessages.length}</strong> total</p>
          </div>
    `;
    
    for (const msg of result) {
      const cssClass = msg.fromMe ? 'from-me' : '';
      const direction = msg.fromMe ? '📤 VOCÊ' : `📥 ${msg.pushName}`;
      const time = new Date(msg.timestamp).toLocaleString('pt-BR');
      
      html += `
        <div class="message ${cssClass}">
          <strong>${direction}</strong> → ${msg.fromNumber}<br>
          <small>${time}</small><br>
          ${msg.text}
        </div>
      `;
    }
    
    html += '</body></html>';
    res.send(html);
  } else {
    res.json({
      messages: result,
      stats: {
        total: allMessages.length,
        filtered: filteredMessages.length,
        sentByMe: allMessages.filter(msg => msg.fromMe).length,
        received: allMessages.filter(msg => !msg.fromMe).length
      }
    });
  }
});

// ✅ Envio com captura FORÇADA
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
    const jid = cleanNumber.includes('@') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
    
    console.log(`📤 Enviando para ${cleanNumber}: ${message}`);
    
    // Enviar mensagem
    const result = await sock.sendMessage(jid, { text: message });
    
    // ✅ FORÇAR captura da mensagem enviada
    const messageData = {
      id: result.key.id,
      from: jid,
      fromNumber: cleanNumber,
      text: message,
      timestamp: new Date().toISOString(),
      pushName: 'Você',
      fromMe: true,
      type: 'text',
      forced: true // Marcar como forçada
    };
    
    // ✅ Salvar com força total
    const saved = saveMessage(messageData, true); // true = forçar como minha mensagem
    
    console.log(`💾 Mensagem ${saved ? 'SALVA' : 'JÁ EXISTIA'} no sistema`);
    
    res.json({ 
      success: true, 
      message: 'Mensagem enviada e capturada!',
      messageId: result.key.id,
      savedToSystem: saved,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Erro ao enviar:', error);
    res.status(500).json({ error: error.message });
  }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp CRM API v2.2 - CAPTURA FORÇADA`);
  console.log(`🎯 Garantia 100%: Mensagens enviadas + recebidas`);
  console.log(`📱 Acesse /qr para conectar`);
  
  connectToWhatsApp();
  keepAlive();
});

cron.schedule('*/30 * * * *', () => {
  const sent = allMessages.filter(m => m.fromMe).length;
  const received = allMessages.filter(m => !m.fromMe).length;
  console.log(`📊 Status: ${sent} enviadas, ${received} recebidas, ${contacts.size} contatos`);
});
