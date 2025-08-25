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
let allMessages = []; // ✅ Guardar TODAS as mensagens
let contacts = new Map();

// Keep-alive para Render
function keepAlive() {
  if (process.env.RENDER_SERVICE_URL) {
    setInterval(() => {
      fetch(process.env.RENDER_SERVICE_URL + '/health').catch(() => {});
    }, 14 * 60 * 1000);
  }
}

// ✅ Função melhorada para salvar TODAS as mensagens
function saveMessage(messageData) {
  // Verificar se já existe (evitar duplicatas)
  const exists = allMessages.some(msg => msg.id === messageData.id);
  if (exists) return;

  allMessages.push({
    ...messageData,
    savedAt: new Date().toISOString()
  });

  // Manter últimas 1000 mensagens
  if (allMessages.length > 1000) {
    allMessages = allMessages.slice(-1000);
  }

  // Atualizar contato
  if (messageData.fromNumber) {
    const existingContact = contacts.get(messageData.fromNumber) || {};
    contacts.set(messageData.fromNumber, {
      ...existingContact,
      name: messageData.pushName || existingContact.name || 'Sem nome',
      phone: messageData.fromNumber,
      lastMessage: messageData.text,
      lastSeen: messageData.timestamp,
      messageCount: (existingContact.messageCount || 0) + 1
    });
  }

  const direction = messageData.fromMe ? '📤 Enviada' : '📥 Recebida';
  console.log(`💾 ${direction} - ${messageData.pushName || 'Você'}: ${messageData.text?.substring(0, 50)}...`);
  console.log(`📊 Total: ${allMessages.length} msgs | ${contacts.size} contatos`);
}

// Conectar ao WhatsApp
async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ['CRM System', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      generateHighQualityLinkPreview: true
    });

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        try {
          qrCodeData = await QRCode.toDataURL(qr);
          console.log('📱 QR Code gerado! Acesse /qr');
        } catch (err) {
          console.error('Erro ao gerar QR:', err);
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
        console.log('✅ WhatsApp conectado! Sistema de captura ativo.');
        isConnected = true;
        qrCodeData = '';
        
        // Carregar conversas existentes
        setTimeout(loadExistingChats, 3000);
      }
    });

    // ✅ CAPTURAR TODAS AS MENSAGENS (RECEBIDAS + ENVIADAS)
    sock.ev.on('messages.upsert', async (m) => {
      try {
        for (const message of m.messages) {
          
          // ✅ Extrair dados da mensagem (funciona para enviadas e recebidas)
          const messageData = {
            id: message.key.id,
            from: message.key.remoteJid,
            fromNumber: message.key.remoteJid?.split('@')[0],
            text: extractMessageText(message),
            timestamp: new Date().toISOString(),
            pushName: message.pushName || (message.key.fromMe ? 'Você' : 'Sem nome'),
            fromMe: Boolean(message.key.fromMe), // ✅ Crucial: identificar se é sua mensagem
            messageTimestamp: message.messageTimestamp,
            type: getMessageType(message)
          };

          // ✅ Salvar TODAS as mensagens válidas
          if (messageData.fromNumber && messageData.fromNumber.length >= 10) {
            saveMessage(messageData);
            
            // Log diferenciado
            if (messageData.fromMe) {
              console.log(`📤 VOCÊ → ${messageData.fromNumber}: ${messageData.text}`);
            } else {
              console.log(`📥 ${messageData.pushName} → VOCÊ: ${messageData.text}`);
            }
          }
        }
      } catch (error) {
        console.error('❌ Erro ao processar mensagens:', error);
      }
    });

    // ✅ Capturar mensagens enviadas via API também
    sock.ev.on('message-receipt.update', (updates) => {
      for (const update of updates) {
        console.log('📧 Recibo de mensagem:', update);
      }
    });

  } catch (error) {
    console.error('❌ Erro na conexão:', error);
    setTimeout(connectToWhatsApp, 5000);
  }
}

// ✅ Função para extrair texto de diferentes tipos de mensagem
function extractMessageText(message) {
  if (message.message?.conversation) {
    return message.message.conversation;
  }
  if (message.message?.extendedTextMessage?.text) {
    return message.message.extendedTextMessage.text;
  }
  if (message.message?.imageMessage?.caption) {
    return `[Imagem] ${message.message.imageMessage.caption}`;
  }
  if (message.message?.videoMessage?.caption) {
    return `[Vídeo] ${message.message.videoMessage.caption}`;
  }
  if (message.message?.audioMessage) {
    return '[Áudio]';
  }
  if (message.message?.documentMessage) {
    return `[Documento] ${message.message.documentMessage.fileName || ''}`;
  }
  if (message.message?.stickerMessage) {
    return '[Sticker]';
  }
  return '[Mídia]';
}

// ✅ Função para identificar tipo de mensagem
function getMessageType(message) {
  if (message.message?.conversation || message.message?.extendedTextMessage) return 'text';
  if (message.message?.imageMessage) return 'image';
  if (message.message?.videoMessage) return 'video';
  if (message.message?.audioMessage) return 'audio';
  if (message.message?.documentMessage) return 'document';
  if (message.message?.stickerMessage) return 'sticker';
  return 'unknown';
}

// ✅ Carregar conversas existentes
async function loadExistingChats() {
  if (!sock) return;
  
  try {
    console.log('📚 Carregando conversas existentes...');
    
    const chats = await sock.getChats();
    console.log(`💬 ${chats.length} conversas encontradas`);
    
    let loadedCount = 0;
    
    // Limitar para não sobrecarregar
    for (const chat of chats.slice(0, 15)) {
      if (chat.id.endsWith('@s.whatsapp.net')) {
        try {
          // Buscar mensagens da conversa
          const messages = await sock.fetchMessagesFromWA(chat.id, 5);
          
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
          
          // Pausa entre conversas
          await new Promise(resolve => setTimeout(resolve, 500));
          
        } catch (error) {
          console.log(`⚠️ Erro ao carregar conversa: ${error.message}`);
        }
      }
    }
    
    console.log(`✅ ${loadedCount} mensagens históricas carregadas!`);
    
  } catch (error) {
    console.error('❌ Erro ao carregar conversas:', error);
  }
}

// 🔗 ROTAS DA API

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    totalMessages: allMessages.length,
    totalContacts: contacts.size,
    connected: isConnected
  });
});

app.get('/', (req, res) => {
  const sentMessages = allMessages.filter(msg => msg.fromMe).length;
  const receivedMessages = allMessages.filter(msg => !msg.fromMe).length;
  
  res.json({
    message: '🚀 WhatsApp CRM API v2.1 - Captura Completa',
    connected: isConnected,
    stats: {
      totalMessages: allMessages.length,
      sentByMe: sentMessages,
      received: receivedMessages,
      totalContacts: contacts.size,
      uptime: Math.round(process.uptime())
    },
    endpoints: {
      '/qr': 'QR Code para conectar',
      '/status': 'Status detalhado',
      '/messages': 'Todas as mensagens',
      '/conversations': 'Conversas agrupadas',
      '/send-message': 'Enviar mensagem'
    }
  });
});

app.get('/qr', (req, res) => {
  if (qrCodeData) {
    res.send(`
      <html>
        <head><title>WhatsApp CRM - QR Code</title>
        <style>body{font-family:Arial;text-align:center;padding:20px;background:#f5f5f5}
        .container{background:white;padding:30px;border-radius:10px;max-width:500px;margin:0 auto}
        img{max-width:300px;border:1px solid #ddd}
        button{background:#25D366;color:white;border:none;padding:10px 20px;border-radius:5px;cursor:pointer}</style>
        </head>
        <body>
          <div class="container">
            <h1>📱 Conectar WhatsApp</h1>
            <p>Escaneie com seu WhatsApp:</p>
            <img src="${qrCodeData}" alt="QR Code">
            <div style="margin:20px">
              <button onclick="window.location.reload()">🔄 Atualizar</button>
            </div>
            <p><small>Versão 2.1 - Captura mensagens enviadas + recebidas</small></p>
          </div>
        </body>
      </html>
    `);
  } else if (isConnected) {
    const sentMessages = allMessages.filter(msg => msg.fromMe).length;
    const receivedMessages = allMessages.filter(msg => !msg.fromMe).length;
    
    res.send(`
      <html>
        <body style="font-family:Arial;text-align:center;padding:50px;background:#f5f5f5">
          <div style="background:white;padding:30px;border-radius:10px;max-width:600px;margin:0 auto">
            <h1>✅ WhatsApp Conectado!</h1>
            <div style="display:flex;justify-content:space-around;margin:20px">
              <div><h3>📤 ${sentMessages}</h3><p>Enviadas</p></div>
              <div><h3>📥 ${receivedMessages}</h3><p>Recebidas</p></div>
              <div><h3>👥 ${contacts.size}</h3><p>Contatos</p></div>
            </div>
            <div style="margin:20px">
              <a href="/messages?format=html" style="margin:10px;padding:10px 20px;background:#25D366;color:white;text-decoration:none;border-radius:5px">📱 Ver Mensagens</a>
              <a href="/conversations" style="margin:10px;padding:10px 20px;background:#1f8ef1;color:white;text-decoration:none;border-radius:5px">💬 Conversas</a>
            </div>
          </div>
        </body>
      </html>
    `);
  } else {
    res.send(`
      <html>
        <body style="font-family:Arial;text-align:center;padding:50px">
          <h1>⏳ Conectando...</h1>
          <p>Aguarde alguns segundos...</p>
          <button onclick="window.location.reload()">🔄 Atualizar</button>
        </body>
      </html>
    `);
  }
});

app.get('/status', (req, res) => {
  const sentMessages = allMessages.filter(msg => msg.fromMe);
  const receivedMessages = allMessages.filter(msg => !msg.fromMe);
  
  res.json({
    connected: isConnected,
    hasQR: !!qrCodeData,
    totalMessages: allMessages.length,
    sentByMe: sentMessages.length,
    received: receivedMessages.length,
    totalContacts: contacts.size,
    uptime: process.uptime(),
    lastMessages: allMessages.slice(-5).map(msg => ({
      from: msg.fromMe ? 'Você' : msg.pushName,
      text: msg.text?.substring(0, 50) + '...',
      timestamp: msg.timestamp,
      fromMe: msg.fromMe
    }))
  });
});

// ✅ Endpoint melhorado de mensagens
app.get('/messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const phone = req.query.phone;
  const format = req.query.format || 'json';
  const onlyFromMe = req.query.fromMe === 'true';
  const onlyReceived = req.query.received === 'true';
  
  let filteredMessages = [...allMessages];
  
  // Filtros
  if (phone) {
    filteredMessages = filteredMessages.filter(msg => msg.fromNumber === phone);
  }
  if (onlyFromMe) {
    filteredMessages = filteredMessages.filter(msg => msg.fromMe);
  }
  if (onlyReceived) {
    filteredMessages = filteredMessages.filter(msg => !msg.fromMe);
  }
  
  // Ordenar (mais recentes primeiro)
  filteredMessages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const result = filteredMessages.slice(0, limit);
  
  if (format === 'html') {
    let html = `
      <html>
        <head><title>Mensagens WhatsApp CRM</title>
        <style>body{font-family:Arial;padding:20px;background:#f5f5f5}
        .message{background:white;padding:15px;margin:10px 0;border-radius:8px;border-left:4px solid #25D366}
        .from-me{border-left-color:#1f8ef1;background:#f0f8ff}
        .historic{border-left-color:#ffa500}</style>
        </head>
        <body>
          <h1>📱 Mensagens WhatsApp CRM (${result.length})</h1>
          <p>📤 ${allMessages.filter(m => m.fromMe).length} enviadas | 
             📥 ${allMessages.filter(m => !m.fromMe).length} recebidas</p>
    `;
    
    for (const msg of result) {
      const cssClass = msg.fromMe ? 'from-me' : (msg.isHistoric ? 'historic' : '');
      const direction = msg.fromMe ? '📤 Você' : `📥 ${msg.pushName}`;
      const time = new Date(msg.timestamp).toLocaleString('pt-BR');
      
      html += `
        <div class="message ${cssClass}">
          <strong>${direction}</strong> (${msg.fromNumber})<br>
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
        received: allMessages.filter(msg => !msg.fromMe).length,
        contacts: contacts.size
      }
    });
  }
});

// ✅ Conversas agrupadas
app.get('/conversations', (req, res) => {
  const conversations = {};
  
  for (const msg of allMessages) {
    if (!conversations[msg.fromNumber]) {
      conversations[msg.fromNumber] = {
        contact: contacts.get(msg.fromNumber) || {
          name: msg.pushName,
          phone: msg.fromNumber
        },
        messages: [],
        lastMessage: '',
        lastTimestamp: '',
        sentCount: 0,
        receivedCount: 0
      };
    }
    
    conversations[msg.fromNumber].messages.push(msg);
    
    if (msg.fromMe) {
      conversations[msg.fromNumber].sentCount++;
    } else {
      conversations[msg.fromNumber].receivedCount++;
    }
  }
  
  // Processar cada conversa
  for (const phone in conversations) {
    const conv = conversations[phone];
    conv.messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    const lastMsg = conv.messages[conv.messages.length - 1];
    if (lastMsg) {
      conv.lastMessage = lastMsg.text;
      conv.lastTimestamp = lastMsg.timestamp;
      conv.lastFromMe = lastMsg.fromMe;
    }
  }
  
  res.json({
    conversations,
    totalConversations: Object.keys(conversations).length,
    totalMessages: allMessages.length
  });
});

// ✅ Enviar mensagem (com captura garantida)
app.post('/send-message', async (req, res) => {
  try {
    const { number, message } = req.body;
    
    if (!number || !message) {
      return res.status(400).json({ error: 'Número e mensagem obrigatórios' });
    }
    
    if (!isConnected) {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }
    
    const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
    
    // Enviar mensagem
    const result = await sock.sendMessage(jid, { text: message });
    
    // ✅ Garantir que a mensagem enviada seja salva
    const messageData = {
      id: result.key.id,
      from: jid,
      fromNumber: number.replace(/\D/g, ''),
      text: message,
      timestamp: new Date().toISOString(),
      pushName: 'Você',
      fromMe: true,
      type: 'text'
    };
    
    // Salvar imediatamente
    saveMessage(messageData);
    
    res.json({ 
      success: true, 
      message: 'Mensagem enviada e salva!',
      messageId: result.key.id,
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
  console.log(`🚀 WhatsApp CRM API v2.1 - Porta ${PORT}`);
  console.log(`🎯 Captura COMPLETA: Mensagens enviadas + recebidas`);
  console.log(`📱 Acesse /qr para conectar`);
  
  connectToWhatsApp();
  keepAlive();
});

// Job de limpeza
cron.schedule('0 */6 * * *', () => {
  console.log(`🧹 Limpeza: ${allMessages.length} mensagens, ${contacts.size} contatos`);
});
