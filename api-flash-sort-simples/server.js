import express from 'express';
import sqlite3 from 'sqlite3';
import crypto from 'crypto';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 4000;

app.use(cors());
app.use(express.json());

// Permite que o Express sirva o arquivo CSS estático
app.use(express.static(__dirname));

const db = new sqlite3.Database(':memory:');

// Banco de dados adaptado com auditoria financeira e status de transação
db.run(`
  CREATE TABLE IF NOT EXISTS participantes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    chave_secreta TEXT,
    banco_validador TEXT,
    tempo_fila_segundos INTEGER,
    valor_original REAL,
    porcentagem_banco REAL,
    valor_liquido REAL,
    status TEXT NOT NULL
  )
`);

// Variáveis de controle
let filaEspera = [];
let conexoesPainel = [];
let sorteioAtivo = false;
let tempoRestante = 0;
let intervaloCronometro = null;
let sistemaProcessando = false;
let faturamentoLiquido = 0;

let ganhadorAtual = null;
let tempoConfirmacaoGanhador = 0;
let intervaloGanhador = null;

function iniciarProcessamento() {
  if (sistemaProcessando) return;
  sistemaProcessando = true;

  const processarProximo = () => {
    if (!sorteioAtivo && filaEspera.length === 0) {
      sistemaProcessando = false;
      enviarParaPainel({ tipo: 'status-sistema', mensagem: 'FlashSort em espera. Aguardando abertura de inscrições...' });
      return;
    }

    if (filaEspera.length > 0) {
      const pedido = filaEspera.shift(); 
      const chaveGerada = crypto.randomBytes(3).toString('hex');

      const tempoFinalizacao = Date.now();
      const tempoGastoNaFila = Math.round((tempoFinalizacao - pedido.timestampEntrada) / 1000);

      const valorOriginal = 2.00;
      const taxaBanco = valorOriginal * 0.10; 
      const valorLiquido = valorOriginal - taxaBanco; 

      db.run(
        `INSERT INTO participantes 
          (nome, chave_secreta, banco_validador, tempo_fila_segundos, valor_original, porcentagem_banco, valor_liquido, status) 
          VALUES (?, ?, ?, ?, ?, ?, ?, 'APROVADO')`, 
        [pedido.nome, chaveGerada, 'Nubank', tempoGastoNaFila, valorOriginal, taxaBanco, valorLiquido], 
        function(err) {
          if (!err) {
            faturamentoLiquido += valorLiquido;
            
            const dadosTicket = {
              ticket: this.lastID,
              nome: pedido.nome,
              banco: 'Nubank',
              chaveSecreta: chaveGerada,
              tempoFila: tempoGastoNaFila,
              lucroLiquido: faturamentoLiquido,
              horario: new Date().toLocaleTimeString()
            };

            enviarParaPainel({
              tipo: 'requisicao-processada',
              ...dadosTicket,
              filaRestante: filaEspera.length
            });

            pedido.callbackSucesso(dadosTicket);
          } else {
            pedido.callbackErro(err.message);
          }
          
          setTimeout(processarProximo, 1000);
        }
      );
    } else {
      setTimeout(processarProximo, 200);
    }
  };
  processarProximo();
}

function enviarParaPainel(dados) {
  conexoesPainel.forEach(p => p.write(`data: ${JSON.stringify(dados)}\n\n`));
}

app.get('/painel-logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  conexoesPainel.push(res);
  req.on('close', () => conexoesPainel = conexoesPainel.filter(p => p !== res));
});

app.post('/comprar-ticket', (req, res) => {
  const { nome } = req.body;

  if (!sorteioAtivo || tempoRestante <= 0) {
    return res.status(400).json({ erro: 'O FlashSort não está ativo ou o tempo esgotou!' });
  }
  if (!nome || nome.trim() === "") {
    return res.status(400).json({ erro: 'Nome inválido.' });
  }

  filaEspera.push({
    nome: nome,
    timestampEntrada: Date.now(),
    callbackSucesso: (dados) => {
      res.status(201).json({
        status: "Aprovado",
        mensagem: "Processado via Nubank (Taxa de 10% aplicada)",
        ticket: dados.ticket,
        chave_secreta: dados.chaveSecreta
      });
    },
    callbackErro: (erro) => {
      res.status(500).json({ erro });
    }
  });

  enviarParaPainel({ 
    tipo: 'nova-requisicao', 
    nome, 
    banco: 'Nubank', 
    filaRestante: filaEspera.length 
  });
});

app.get('/painel/dados-analise', (req, res) => {
  db.all('SELECT * FROM participantes', [], (err, rows) => {
    if (err) return res.status(500).json({ erro: err.message });
    res.json(rows);
  });
});

app.post('/painel/iniciar', (req, res) => {
  if (sorteioAtivo) return res.status(400).send('FlashSort já está rodando.');
  sorteioAtivo = true;
  tempoRestante = 60;
  filaEspera = [];
  iniciarProcessamento();

  intervaloCronometro = setInterval(() => {
    tempoRestante--;
    enviarParaPainel({ tipo: 'tempo', tempo: tempoRestante, filaRestante: filaEspera.length });

    if (tempoRestante <= 0) {
      clearInterval(intervaloCronometro);
      sorteioAtivo = false;
      
      const momentoRejeicao = Date.now();
      let totalSalvoRejeitados = 0;

      filaEspera.forEach(pedido => {
        const tempoEsperaFila = Math.round((momentoRejeicao - pedido.timestampEntrada) / 1000);
        
        db.run(
          `INSERT INTO participantes 
            (nome, chave_secreta, banco_validador, tempo_fila_segundos, valor_original, porcentagem_banco, valor_liquido, status) 
            VALUES (?, NULL, 'Nubank', ?, 2.00, 0.00, 0.00, 'REJEITADO')`,
          [pedido.nome, tempoEsperaFila]
        );

        pedido.callbackErro('A transação expirou! O tempo do lote acabou e o Nubank cancelou a operação.');
        totalSalvoRejeitados++;
      });

      enviarParaPainel({ 
        tipo: 'fim-tempo', 
        mensagem: `Tempo ESGOTADO! ${totalSalvoRejeitados} requisições foram REJEITADAS e registradas no banco para auditoria.`,
        filaRestante: 0
      });
      filaEspera = []; 
    }
  }, 1000);
  res.sendStatus(200);
});

app.get('/painel/sortear', (req, res) => {
  if (intervaloGanhador) clearInterval(intervaloGanhador);

  db.all("SELECT * FROM participantes WHERE status = 'APROVADO'", [], (err, rows) => {
    if (err || rows.length === 0) {
      return res.status(400).json({ erro: 'Nenhum pagamento aprovado disponível para o sorteio.' });
    }
    
    ganhadorAtual = rows[Math.floor(Math.random() * rows.length)];
    tempoConfirmacaoGanhador = 60;

    enviarParaPainel({ 
      tipo: 'ganhador-sorteado', 
      ticket: ganhadorAtual.id, 
      nome: ganhadorAtual.nome,
      banco: ganhadorAtual.banco_validador,
      tempo: tempoConfirmacaoGanhador
    });

    intervaloGanhador = setInterval(() => {
      tempoConfirmacaoGanhador--;
      enviarParaPainel({ tipo: 'tempo-ganhador', tempo: tempoConfirmacaoGanhador });

      if (tempoConfirmacaoGanhador <= 0) {
        clearInterval(intervaloGanhador);
        enviarParaPainel({ tipo: 'ganhador-expirou', mensagem: `O Ticket #${ganhadorAtual.id} (${ganhadorAtual.nome}) expirou sem validação.` });
        ganhadorAtual = null;
      }
    }, 1000);

    res.json({ ticket: ganhadorAtual.id, nome: ganhadorAtual.nome });
  });
});

app.post('/confirmar-premio', (req, res) => {
  const { ticket, chave } = req.body;

  if (!ganhadorAtual || tempoConfirmacaoGanhador <= 0) {
    return res.status(400).json({ erro: 'Nenhum prêmio aguardando validação ativa.' });
  }

  if (Number(ticket) === ganhadorAtual.id && chave === ganhadorAtual.chave_secreta) {
    clearInterval(intervaloGanhador);
    enviarParaPainel({ tipo: 'ganhador-confirmado', nome: ganhadorAtual.nome, ticket: ganhadorAtual.id });
    ganhadorAtual = null;
    return res.json({ sucesso: true, mensagem: 'Prêmio confirmado e liberado! 🏆' });
  } else {
    return res.status(400).json({ erro: 'Chave secreta ou ticket inválidos.' });
  }
});

app.post('/painel/limpar', (req, res) => {
  clearInterval(intervaloCronometro);
  clearInterval(intervaloGanhador);
  sorteioAtivo = false;
  tempoRestante = 0;
  tempoConfirmacaoGanhador = 0;
  filaEspera = [];
  faturamentoLiquido = 0;
  ganhadorAtual = null;
  db.run('DELETE FROM participantes', () => {
    enviarParaPainel({ tipo: 'limpar-tela' });
    res.sendStatus(200);
  });
});

// Entrega o arquivo HTML externo na rota /painel
app.get('/painel', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`[FlashSort] Servidor rodando com sucesso na porta ${PORT}`));