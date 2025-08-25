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
let allMessages = []; // 🆕 Array para guardar TODAS as mensagens
let contacts = new Map(); // 🆕 Map para guardar info dos contatos

// URLs dos webhooks
const NOTION_WEBHOOK = process.env.NOTION_WEBHOOK || '';
const N8N_WEBHOOK = process.env.N8N_WEBHOOK || '';

// Keep-alive
function keepAlive() {
  if (process.env.RENDER_SERVICE_URL) {
    setInterval(() => {
      fetch(process.env.RENDER_SERVICE_URL + '/health')
        .catch(() => {});
    }, 14 * 60 * 1000);
  }
}

// Função para salvar mensagem
function saveMessage(messageData) {
  // Adicionar à lista de todas as mensagens
  allMessages.push({
    ...messageData,
    savedAt: new Date().toISOString()
  });

  // Manter apenas as últimas 500 mensagens para não sobrecarregar
  if (allMessages.length > 500) {
    allMessages = allMessages.slice(-500);
  }

  // Atualizar info do contato
  contacts.set(messageData.fromNumber, {
    name: messageData.pushName || 'Sem nome',
    phone: messageData.fromNumber,
    lastMessage: messageData.text,
    lastSeen: messageData.timestamp,
    messageCount: (contacts.get(messageData.fromNumber)?.messageCount || 0) + 1
  });

  console.log(`💾 Mensagem salva - Total: ${allMessages.length} | Contatos: ${contacts.size}`);
}

// Função para enviar para webhooks
async function sendToWebhooks(messageData) {
  const webhooks = [NOTION_WEBHOOK, N8N_WEBHOOK].filter(url => url);
  
  for (const webhookUrl of webhooks) {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messageData)
      });
      console.log(`📤 Enviado para webhook: ${webhookUrl.substring(0, 50)}...`);
    } catch (error) {
      console.log(`❌ Erro no webhook: ${error.message}`);
    }
  }
}

// Conectar ao WhatsApp
async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ['CRM System', 'Chrome', '1.0.0'],
      syncFullHistory: true // 🆕 Tentar sincronizar histórico
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
        console.log('✅ WhatsApp conectado! Buscando conversas...');
        isConnected = true;
        qrCodeData = '';
        
        // 🆕 Tentar carregar conversas existentes
        await loadExistingChats();
      }
    });

    // 🆕 Escutar mensagens (recebidas e enviadas)
    sock.ev.on('messages.upsert', async (m) => {
      try {
        for (const message of m.messages) {
          const messageData = {
            id: message.key.id,
            from: message.key.remoteJid,
            fromNumber: message.key.remoteJid?.split('@')[0],
            text: message.message?.conversation || 
                  message.message?.extendedTextMessage?.text || 
                  '[Mídia]',
            timestamp: new Date().toISOString(),
            pushName: message.pushName || 'Sem nome',
            fromMe: message.key.fromMe || false,
            messageTimestamp: message.messageTimestamp
          };

          // Salvar todas as mensagens (recebidas e enviadas)
          if (messageData.fromNumber) {
            saveMessage(messageData);
            
            // Enviar para webhooks apenas se não for minha mensagem
            if (!messageData.fromMe) {
              console.log('📨 Nova mensagem recebida:', {
                de: messageData.pushName,
                numero: messageData.fromNumber,
                texto: messageData.text
              });
              
              await sendToWebhooks(messageData);
            }
          }
        }
      } catch (error) {
        console.error('Erro ao processar mensagens:', error);
      }
    });

    // 🆕 Escutar atualizações de contatos
    sock.ev.on('contacts.update', (contacts) => {
      for (const contact of contacts) {
        if (contact.id && contact.name) {
          const phone = contact.id.split('@')[0];
          contacts.set(phone, {
            ...contacts.get(phone),
            name: contact.name,
            phone: phone
          });
        }
      }
    });

  } catch (error) {
    console.error('Erro na conexão:', error);
    setTimeout(connectToWhatsApp, 5000);
  }
}

// 🆕 Função para carregar conversas existentes
async function loadExistingChats() {
  if (!sock) return;
  
  try {
    console.log('📚 Carregando conversas existentes...');
    
    // Buscar todas as conversas
    const chats = await sock.getChats();
    console.log(`💬 ${chats.length} conversas encontradas`);
    
    let loadedMessages = 0;
    
    for (const chat of chats.slice(0, 20)) { // Limitar a 20 conversas mais recentes
      if (chat.id.endsWith('@s.whatsapp.net')) { // Apenas conversas individuais
        try {
          // Buscar mensagens da conversa
          const messages = await sock.fetchMessagesFromWA(chat.id, 10); // Últimas 10 mensagens
          
          for (const msg of messages) {
            const messageData = {
              id: msg.key.id,
              from: msg.key.remoteJid,
              fromNumber: msg.key.remoteJid?.split('@')[0],
              text: msg.message?.conversation || 
                    msg.message?.extendedTextMessage?.text || 
                    '[Mídia]',
              timestamp: new Date(msg.messageTimestamp * 1000).toISOString(),
              pushName: msg.pushName || chat.name || 'Sem nome',
              fromMe: msg.key.fromMe || false,
              messageTimestamp: msg.messageTimestamp,
              isHistoric: true // 🆕 Marcar como histórica
            };

            if (messageData.fromNumber) {
              saveMessage(messageData);
              loadedMessages++;
            }
          }
          
          // Pequena pausa entre conversas
          await new Promise(resolve => setTimeout(resolve, 500));
          
        } catch (error) {
          console.log(`⚠️ Erro ao carregar conversa ${chat.id}:`, error.message);
        }
      }
    }
    
    console.log(`✅ ${loadedMessages} mensagens históricas carregadas!`);
    
  } catch (error) {
    console.error('Erro ao carregar conversas:', error);
  }
}

// 🔗 ROTAS DA API

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    totalMessages: allMessages.length,
    totalContacts: contacts.size
  });
});

app.get('/', (req, res) => {
  res.json({
    message: '🚀 API WhatsApp CRM (v2.0)',
    connected: isConnected,
    stats: {
      totalMessages: allMessages.length,
      totalContacts: contacts.size,
      uptime: process.uptime()
    },
    endpoints: {
      '/qr': 'QR Code para conectar',
      '/status': 'Status da conexão',
      '/messages': 'Todas as mensagens',
      '/conversations': '🆕 Conversas agrupadas',
      '/contacts': '🆕 Lista de contatos',
      '/send-message': 'Enviar mensagem'
    }
  });
});

app.get('/qr', (req, res) => {
  if (qrCodeData) {
    res.send(`
      <html>
        <head>
          <title>QR Code WhatsApp CRM</title>
          <style>
            body { font-family: Arial; text-align: center; padding: 20px; background: #f5f5f5; }
            .container { background: white; padding: 30px; border-radius: 10px; max-width: 500px; margin: 0 auto; }
            img { max-width: 300px; border: 1px solid #ddd; }
            .refresh { margin: 20px; }
            button { background: #25D366; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>📱 Conectar WhatsApp ao CRM</h1>
            <p>Escaneie com seu WhatsApp:</p>
            <img src="${qrCodeData}" alt="QR Code">
            <div class="refresh">
              <button onclick="window.location.reload()">🔄 Atualizar</button>
            </div>
            <p><small>Após conectar, suas conversas serão sincronizadas automaticamente</small></p>
          </div>
        </body>
      </html>
    `);
  } else if (isConnected) {
    res.send(`
      <html>
        <body style="font-family: Arial; text-align: center; padding: 50px; background: #f5f5f5;">
          <div style="background: white; padding: 30px; border-radius: 10px; max-width: 500px; margin: 0 auto;">
            <h1>✅ WhatsApp Conectado!</h1>
            <p>📊 ${allMessages.length} mensagens sincronizadas</p>
            <p>👥 ${contacts.size} contatos encontrados</p>
            <div style="margin: 20px;">
              <a href="/messages" style="margin: 10px; padding: 10px 20px; background: #25D366; color: white; text-decoration: none; border-radius: 5px;">📱 Ver Mensagens</a>
              <a href="/conversations" style="margin: 10px; padding: 10px 20px; background: #1f8ef1; color: white; text-decoration: none; border-radius: 5px;">💬 Ver Conversas</a>
            </div>
          </div>
        </body>
      </html>
    `);
  } else {
    res.send(`
      <html>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1>⏳ Conectando...</h1>
          <p>Aguarde alguns segundos...</p>
          <button onclick="window.location.reload()">🔄 Atualizar</button>
        </body>
      </html>
    `);
  }
});

// 🆕 Endpoint melhorado para mensagens
app.get('/messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const phone = req.query.phone;
  const format = req.query.format || 'json';
  
  let filteredMessages = allMessages;
  
  // Filtrar por telefone se especificado
  if (phone) {
    filteredMessages = allMessages.filter(msg => msg.fromNumber === phone);
  }
  
  // Ordenar por timestamp (mais recentes primeiro)
  filteredMessages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  const result = filteredMessages.slice(0, limit);
  
  if (format === 'html') {
    // Formato HTML para visualização
    let html = `
      <html>
        <head>
          <title>Mensagens WhatsApp</title>
          <style>
            body { font-family: Arial; padding: 20px; background: #f5f5f5; }
            .message { background: white; padding: 15px; margin: 10px 0; border-radius: 8px; border-left: 4px solid #25D366; }
            .from-me { border-left-color: #1f8ef1; background: #f0f8ff; }
            .historic { border-left-color: #ffa500; }
          </style>
        </head>
        <body>
          <h1>📱 Mensagens WhatsApp (${result.length})</h1>
    `;
    
    for (const msg of result) {
      const cssClass = msg.fromMe ? 'from-me' : (msg.isHistoric ? 'historic' : '');
      const direction = msg.fromMe ? '👤 Você' : `📞 ${msg.pushName}`;
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
    // Formato JSON
    res.json({
      messages: result,
      total: allMessages.length,
      filtered: filteredMessages.length,
      contacts: contacts.size
    });
  }
});

// 🆕 Endpoint para conversas agrupadas
app.get('/conversations', (req, res) => {
  const conversations = {};
  
  // Agrupar mensagens por telefone
  for (const msg of allMessages) {
    if (!conversations[msg.fromNumber]) {
      conversations[msg.fromNumber] = {
        contact: contacts.get(msg.fromNumber) || {
          name: msg.pushName,
          phone: msg.fromNumber
        },
        messages: [],
        lastMessage: '',
        lastTimestamp: ''
      };
    }
    
    conversations[msg.fromNumber].messages.push(msg);
  }
  
  // Ordenar mensagens dentro de cada conversa e pegar última
  for (const phone in conversations) {
    const conv = conversations[phone];
    conv.messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    const lastMsg = conv.messages[conv.messages.length - 1];
    if (lastMsg) {
      conv.lastMessage = lastMsg.text;
      conv.lastTimestamp = lastMsg.timestamp;
    }
  }
  
  res.json({
    conversations,
    totalConversations: Object.keys(conversations).length,
    totalMessages: allMessages.length
  });
});

// 🆕 Endpoint para contatos
app.get('/contacts', (req, res) => {
  const contactsList = Array.from(contacts.values());
  res.json({
    contacts: contactsList,
    total: contactsList.length
  });
});

// Endpoint para enviar mensagem
app.post('/send-message', async (req, res) => {
  try {
    const { number, message } = req.body;
    
    if (!number || !message) {
      return res.status(400).json({ 
        error: 'Número e mensagem são obrigatórios' 
      });
    }
    
    if (!isConnected) {
      return res.status(400).json({ 
        error: 'WhatsApp não conectado' 
      });
    }
    
    const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    
    // Salvar mensagem enviada
    const messageData = {
      id: Date.now().toString(),
      from: jid,
      fromNumber: number,
      text: message,
      timestamp: new Date().toISOString(),
      pushName: 'Você',
      fromMe: true
    };
    
    saveMessage(messageData);
    
    res.json({ 
      success: true, 
      message: 'Mensagem enviada!',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp CRM API v2.0 - Porta ${PORT}`);
  console.log(`📱 Acesse /qr para conectar`);
  
  connectToWhatsApp();
  keepAlive();
});

// Keep-alive job
cron.schedule('*/5 * * * *', () => {
  console.log(`⏰ Sistema ativo - ${allMessages.length} mensagens, ${contacts.size} contatos`);
});
