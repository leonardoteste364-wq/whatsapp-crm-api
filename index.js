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
let messageHistory = [];

// Keep-alive para evitar hibernação
const WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';

// Função para manter ativo
function keepAlive() {
  if (process.env.RENDER_SERVICE_URL) {
    setInterval(() => {
      fetch(process.env.RENDER_SERVICE_URL + '/health')
        .catch(() => {}); // Ignora erros
    }, 14 * 60 * 1000); // A cada 14 minutos
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
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        try {
          qrCodeData = await QRCode.toDataURL(qr);
          console.log('QR Code gerado! Acesse /qr para visualizar');
        } catch (err) {
          console.error('Erro ao gerar QR:', err);
        }
      }
      
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('Conexão fechada. Tentando reconectar...', shouldReconnect);
        
        if (shouldReconnect) {
          setTimeout(connectToWhatsApp, 3000);
        }
        isConnected = false;
        qrCodeData = '';
      } else if (connection === 'open') {
        console.log('✅ WhatsApp conectado com sucesso!');
        isConnected = true;
        qrCodeData = '';
      }
    });

    // Escutar mensagens recebidas
    sock.ev.on('messages.upsert', async (m) => {
      try {
        const message = m.messages[0];
        
        if (!message.key.fromMe && m.type === 'notify') {
          const messageData = {
            id: message.key.id,
            from: message.key.remoteJid,
            fromNumber: message.key.remoteJid?.split('@')[0],
            text: message.message?.conversation || 
                  message.message?.extendedTextMessage?.text || 
                  '[Mídia]',
            timestamp: new Date().toISOString(),
            pushName: message.pushName || 'Sem nome'
          };

          messageHistory.push(messageData);
          
          // Manter apenas últimas 100 mensagens na memória
          if (messageHistory.length > 100) {
            messageHistory = messageHistory.slice(-100);
          }

          console.log('📨 Nova mensagem:', {
            de: messageData.pushName,
            numero: messageData.fromNumber,
            texto: messageData.text
          });

          // Enviar para N8n (webhook)
          if (WEBHOOK_URL) {
            try {
              await fetch(WEBHOOK_URL, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(messageData)
              });
            } catch (error) {
              console.log('Erro ao enviar para N8n:', error.message);
            }
          }
        }
      } catch (error) {
        console.error('Erro ao processar mensagem:', error);
      }
    });

  } catch (error) {
    console.error('Erro na conexão:', error);
    setTimeout(connectToWhatsApp, 5000);
  }
}

// 🔗 ROTAS DA API

// Health check (para manter ativo)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Página inicial
app.get('/', (req, res) => {
  res.json({
    message: '🚀 API WhatsApp CRM funcionando!',
    connected: isConnected,
    version: '1.0.0',
    endpoints: {
      qr: '/qr - Obter QR Code',
      status: '/status - Status da conexão',
      send: '/send-message - Enviar mensagem',
      messages: '/messages - Histórico de mensagens'
    }
  });
});

// QR Code
app.get('/qr', (req, res) => {
  if (qrCodeData) {
    res.send(`
      <html>
        <head>
          <title>QR Code WhatsApp</title>
          <style>
            body { font-family: Arial; text-align: center; padding: 20px; }
            img { max-width: 400px; }
            .refresh { margin: 20px; }
          </style>
        </head>
        <body>
          <h1>📱 Conectar WhatsApp</h1>
          <p>Escaneie o código com seu WhatsApp:</p>
          <img src="${qrCodeData}" alt="QR Code">
          <div class="refresh">
            <button onclick="window.location.reload()">🔄 Atualizar</button>
          </div>
          <p><small>Após escanear, aguarde alguns segundos e verifique o status em /status</small></p>
        </body>
      </html>
    `);
  } else if (isConnected) {
    res.send(`
      <html>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1>✅ WhatsApp Conectado!</h1>
          <p>Sua API está funcionando perfeitamente.</p>
          <a href="/status">Ver Status Detalhado</a>
        </body>
      </html>
    `);
  } else {
    res.send(`
      <html>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1>⏳ Aguardando Conexão...</h1>
          <p>Iniciando WhatsApp. Atualize em alguns segundos.</p>
          <button onclick="window.location.reload()">🔄 Atualizar</button>
        </body>
      </html>
    `);
  }
});

// Status detalhado
app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    hasQR: !!qrCodeData,
    totalMessages: messageHistory.length,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Enviar mensagem
app.post('/send-message', async (req, res) => {
  try {
    const { number, message } = req.body;
    
    if (!number || !message) {
      return res.status(400).json({ 
        error: 'Número e mensagem são obrigatórios',
        example: { number: '5511999999999', message: 'Olá!' }
      });
    }
    
    if (!isConnected) {
      return res.status(400).json({ 
        error: 'WhatsApp não conectado. Acesse /qr para conectar' 
      });
    }
    
    const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    
    res.json({ 
      success: true, 
      message: 'Mensagem enviada com sucesso!',
      to: number,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
    res.status(500).json({ 
      error: 'Erro ao enviar mensagem: ' + error.message 
    });
  }
});

// Histórico de mensagens
app.get('/messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    messages: messageHistory.slice(-limit),
    total: messageHistory.length
  });
});

// Webhook para N8n (receber comandos)
app.post('/webhook', async (req, res) => {
  try {
    const { action, number, message } = req.body;
    
    if (action === 'send_message' && number && message) {
      if (!isConnected) {
        return res.status(400).json({ error: 'WhatsApp não conectado' });
      }
      
      const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
      await sock.sendMessage(jid, { text: message });
      
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Ação inválida' });
    }
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📱 Acesse /qr para conectar o WhatsApp`);
  
  // Iniciar WhatsApp
  connectToWhatsApp();
  
  // Iniciar keep-alive
  keepAlive();
});

// Manter ativo com cron job
cron.schedule('*/10 * * * *', () => {
  console.log('⏰ Keep-alive ping');
});
