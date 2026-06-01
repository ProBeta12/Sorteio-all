import express from 'express';
import sqlite3 from 'sqlite3';
import crypto from 'crypto';
import cors from 'cors';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const db = new sqlite3.Database(':memory:');

// Banco de dados com auditoria financeira completa
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

// Configuração estática dos 4 bancos validadores
const BANCOS = {
  Nubank: { nome: 'Nubank', taxa: 0.10, velocidade: 1000, ativo: true },
  Inter: { nome: 'Inter', taxa: 0.20, velocidade: 500, ativo: false, gatilhoAtivar: 10 },
  Itau: { nome: 'Itaú', taxa: 0.30, velocidade: 500, ativo: false, gatilhoAtivar: 20 },
  SolanaPay: { nome: 'SolanaPay', taxa: 0.80, velocidade: 0, ativo: false, gatilhoAtivar: 60 }
};

let filaEspera = [];
let conexoesPainel = [];
let sorteioAtivo = false;
let tempoRestante = 0;
let intervaloCronometro = null;
let faturamentoLiquido = 0;

let ganhadorAtual = null;
let tempoConfirmacaoGanhador = 0;
let intervaloGanhador = null;

// Controladores de loop ativo de cada banco
const rotinasBancos = { Nubank: false, Inter: false, Itau: false };

// Calcula o tempo estimado de espera baseado nas taxas de processamento dos bancos atualmente ativos
function calcularTempoEsperaFila() {
  let requisicoesPorSegundo = 0;
  if (BANCOS.Nubank.ativo) requisicoesPorSegundo += (1000 / BANCOS.Nubank.velocidade);
  if (BANCOS.Inter.ativo) requisicoesPorSegundo += (1000 / BANCOS.Inter.velocidade);
  if (BANCOS.Itau.ativo) requisicoesPorSegundo += (1000 / BANCOS.Itau.velocidade);
  
  if (requisicoesPorSegundo === 0 || filaEspera.length === 0) return 0;
  return Math.round(filaEspera.length / requisicoesPorSegundo);
}

// Algoritmo de Roteamento Dinâmico com Estratégia de Drenagem Total (Porteira Aberta)
function gerenciarAlgoritmoRoteamento() {
  const tempoEsperaAtual = calcularTempoEsperaFila();

  // 1. Regras de Ativação por Gargalo
  if (!BANCOS.Inter.ativo && tempoEsperaAtual >= BANCOS.Inter.gatilhoAtivar) {
    BANCOS.Inter.ativo = true;
    iniciarLoopBanco('Inter');
  }
  if (!BANCOS.Itau.ativo && tempoEsperaAtual >= BANCOS.Itau.gatilhoAtivar) {
    BANCOS.Itau.ativo = true;
    iniciarLoopBanco('Itau');
  }
  if (!BANCOS.SolanaPay.ativo && tempoEsperaAtual > BANCOS.SolanaPay.gatilhoAtivar) {
    BANCOS.SolanaPay.ativo = true;
  }

  // 2. Regra de Desativação Estratégica: Só desliga se a fila zerar completamente
  if (filaEspera.length === 0) {
    BANCOS.Inter.ativo = false;
    BANCOS.Itau.ativo = false;
    BANCOS.SolanaPay.ativo = false;
  }

  // 3. Processamento de Tempo Máximo (SolanaPay ativa drena tudo na velocidade da rede instantaneamente)
  if (BANCOS.SolanaPay.ativo && filaEspera.length > 0) {
    while (filaEspera.length > 0 && BANCOS.SolanaPay.ativo) {
      const pedido = filaEspera.shift();
      if (pedido) processarTransacao(pedido, BANCOS.SolanaPay);
    }
    // Após drenar tudo, reseta os bancos adicionais para o estado falso
    BANCOS.Inter.ativo = false;
    BANCOS.Itau.ativo = false;
    BANCOS.SolanaPay.ativo = false;
  }

  // Envia atualização de status para o dashboard
  enviarParaPainel({
    tipo: 'status-bancos',
    bancos: BANCOS,
    tempoEspera: calcularTempoEsperaFila()
  });
}

// Inicia loops assíncronos individuais para os validadores baseados em timeout
function iniciarLoopBanco(chaveBanco) {
  if (rotinasBancos[chaveBanco]) return;
  rotinasBancos[chaveBanco] = true;

  const rodar = () => {
    if (!sorteioAtivo && filaEspera.length === 0) {
      rotinasBancos[chaveBanco] = false;
      return;
    }
    if (!BANCOS[chaveBanco].ativo && chaveBanco !== 'Nubank') {
      rotinasBancos[chaveBanco] = false;
      return;
    }

    if (filaEspera.length > 0) {
      const pedido = filaEspera.shift();
      if (pedido) {
        processarTransacao(pedido, BANCOS[chaveBanco]);
      }
      setTimeout(rodar, BANCOS[chaveBanco].velocidade);
    } else {
      setTimeout(rodar, 150);
    }
  };
  rodar();
}

function processarTransacao(pedido, banco) {
  const chaveGerada = crypto.randomBytes(3).toString('hex');
  const tempoGastoNaFila = Math.round((Date.now() - pedido.timestampEntrada) / 1000);

  const valorOriginal = 2.00;
  const taxaBanco = valorOriginal * banco.taxa;
  const valorLiquido = valorOriginal - taxaBanco;

  db.run(
    `INSERT INTO participantes 
      (nome, chave_secreta, banco_validador, tempo_fila_segundos, valor_original, porcentagem_banco, valor_liquido, status) 
      VALUES (?, ?, ?, ?, ?, ?, ?, 'APROVADO')`, 
    [pedido.nome, chaveGerada, banco.nome, tempoGastoNaFila, valorOriginal, taxaBanco, valorLiquido], 
    function(err) {
      if (!err) {
        faturamentoLiquido += valorLiquido;
        
        const dadosTicket = {
          ticket: this.lastID,
          nome: pedido.nome,
          banco: banco.nome,
          taxaCobranca: taxaBanco,
          chaveSecreta: chaveGerada,
          tempoFila: tempoGastoNaFila,
          lucroLiquido: faturamentoLiquido
        };

        enviarParaPainel({
          tipo: 'requisicao-processada',
          ...dadosTicket,
          filaRestante: filaEspera.length,
          tempoEspera: calcularTempoEsperaFila()
        });

        pedido.callbackSucesso(dadosTicket);
      } else {
        pedido.callbackErro(err.message);
      }
      gerenciarAlgoritmoRoteamento();
    }
  );
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

// Rota de Entrada / Compra de Tickets (CORRIGIDO: Agora devolve a chave_secreta e o ticket de volta para o Front/Postman)
app.post('/comprar-ticket', (req, res) => {
  const { nome } = req.body;

  if (!sorteioAtivo || tempoRestante <= 0) {
    return res.status(400).json({ erro: 'FlashSort inativo ou tempo do lote esgotado!' });
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
        ticket: dados.ticket, 
        validador: dados.banco,
        chave_secreta: dados.chaveSecreta // <-- Linha adicionada para corrigir seu problema de visualização de Token no cliente
      });
    },
    callbackErro: (erro) => {
      res.status(500).json({ erro });
    }
  });

  enviarParaPainel({ tipo: 'nova-requisicao', nome, filaRestante: filaEspera.length, tempoEspera: calcularTempoEsperaFila() });
  gerenciarAlgoritmoRoteamento();
});

// Endpoint Analítico para os Gráficos externos consumirem
app.get('/painel/dados-analise', (req, res) => {
  db.all('SELECT * FROM participantes', [], (err, rows) => {
    if (err) return res.status(500).json({ erro: err.message });
    res.json(rows);
  });
});

// Iniciar Lote de 1 minuto
app.post('/painel/iniciar', (req, res) => {
  if (sorteioAtivo) return res.status(400).send('FlashSort já está rodando.');
  sorteioAtivo = true;
  tempoRestante = 60;
  filaEspera = [];
  
  BANCOS.Inter.ativo = false;
  BANCOS.Itau.ativo = false;
  BANCOS.SolanaPay.ativo = false;

  iniciarLoopBanco('Nubank');

  intervaloCronometro = setInterval(() => {
    tempoRestante--;
    enviarParaPainel({ tipo: 'tempo', tempo: tempoRestante, filaRestante: filaEspera.length, tempoEspera: calcularTempoEsperaFila() });

    if (tempoRestante <= 0) {
      clearInterval(intervaloCronometro);
      sorteioAtivo = false;
      
      const momentoRejeicao = Date.now();
      let totalSalvoRejeitados = 0;

      // Grava na tabela de auditoria todos os leads que restaram travados após o fim de 1 min
      filaEspera.forEach(pedido => {
        const tempoEsperaFila = Math.round((momentoRejeicao - pedido.timestampEntrada) / 1000);
        db.run(
          `INSERT INTO participantes 
            (nome, chave_secreta, banco_validador, tempo_fila_segundos, valor_original, porcentagem_banco, valor_liquido, status) 
            VALUES (?, NULL, 'Descartado', ?, 2.00, 0.00, 0.00, 'REJEITADO')`,
          [pedido.nome, tempoEsperaFila]
        );
        pedido.callbackErro('Lote encerrado. Transação descartada sem cobrança.');
        totalSalvoRejeitados++;
      });

      enviarParaPainel({ 
        tipo: 'fim-tempo', 
        mensagem: `Tempo ESGOTADO! ${totalSalvoRejeitados} requisições pendentes foram arquivadas como REJEITADAS.`,
        filaRestante: 0
      });
      filaEspera = []; 
    }
  }, 1000);
  res.sendStatus(200);
});

// Rotas auxiliares de sorteio e premiação
app.get('/painel/sortear', (req, res) => {
  if (intervaloGanhador) clearInterval(intervaloGanhador);
  db.all("SELECT * FROM participantes WHERE status = 'APROVADO'", [], (err, rows) => {
    if (err || rows.length === 0) return res.status(400).json({ erro: 'Sem transações aprovadas disponíveis.' });
    ganhadorAtual = rows[Math.floor(Math.random() * rows.length)];
    tempoConfirmacaoGanhador = 60;
    enviarParaPainel({ tipo: 'ganhador-sorteado', ticket: ganhadorAtual.id, nome: ganhadorAtual.nome, banco: ganhadorAtual.banco_validador, tempo: tempoConfirmacaoGanhador });
    
    intervaloGanhador = setInterval(() => {
      tempoConfirmacaoGanhador--;
      enviarParaPainel({ tipo: 'tempo-ganhador', tempo: tempoConfirmacaoGanhador });
      if (tempoConfirmacaoGanhador <= 0) {
        clearInterval(intervaloGanhador);
        enviarParaPainel({ tipo: 'ganhador-expirou', mensagem: `O Ticket #${ganhadorAtual.id} expirou.` });
        ganhadorAtual = null;
      }
    }, 1000);
    res.json({ ticket: ganhadorAtual.id, nome: ganhadorAtual.nome });
  });
});

app.post('/confirmar-premio', (req, res) => {
  const { ticket, chave } = req.body;
  if (!ganhadorAtual) return res.status(400).json({ erro: 'Sem sorteio ativo aguardando validação.' });
  if (Number(ticket) === ganhadorAtual.id && chave === ganhadorAtual.chave_secreta) {
    clearInterval(intervaloGanhador);
    enviarParaPainel({ tipo: 'ganhador-confirmado', nome: ganhadorAtual.nome, ticket: ganhadorAtual.id });
    ganhadorAtual = null;
    return res.json({ sucesso: true });
  }
  return res.status(400).json({ erro: 'Dados de validação inconsistentes.' });
});

// Rota de Limpar Tudo (CORRIGIDO: Agora reseta os loops de rotina e estados ativos de todos os bancos de volta para o padrão)
app.post('/painel/limpar', (req, res) => {
  clearInterval(intervaloCronometro);
  clearInterval(intervaloGanhador);
  sorteioAtivo = false;
  tempoRestante = 0;
  filaEspera = [];
  faturamentoLiquido = 0;
  ganhadorAtual = null;

  // Reseta o estado físico operacional de todos os balanceadores
  BANCOS.Inter.ativo = false;
  BANCOS.Itau.ativo = false;
  BANCOS.SolanaPay.ativo = false;
  rotinasBancos.Inter = false;
  rotinasBancos.Itau = false;

  db.run('DELETE FROM participantes', () => {
    enviarParaPainel({ tipo: 'limpar-tela' });
    res.sendStatus(200);
  });
});

// Dashboard Administrativo em tempo real
app.get('/painel', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <title>FlashSort - Balancer Multi-Bancos</title>
      <style>
        body { font-family: system-ui, sans-serif; background: #0c0c0e; color: #f5f5f7; padding: 20px; max-width: 1200px; margin: 0 auto; }
        h1 { color: #820ad1; text-align: center; margin-bottom: 5px; font-weight: 800; }
        h2.subtitle { text-align: center; color: #a8a8b3; font-size: 1.1rem; margin-top: 0; margin-bottom: 25px; font-weight: 400; }
        
        .stats-topo { display: flex; gap: 20px; justify-content: center; margin: 15px 0; }
        .stat-card { background: #18181b; border: 1px solid #27272a; padding: 10px 25px; border-radius: 12px; text-align: center; min-width: 180px; }
        .stat-card h4 { margin: 0; color: #a1a1aa; font-size: 0.85rem; text-transform: uppercase; }
        .stat-card p { margin: 5px 0 0 0; font-size: 2rem; font-weight: bold; }
        #tempo { color: #ff9000; }
        #faturamento { color: #04d361; }

        .bancos-container { background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 15px; margin-bottom: 25px; }
        .bancos-container h3 { margin-top: 0; font-size: 0.9rem; color: #a1a1aa; text-transform: uppercase; text-align: center; margin-bottom: 15px;}
        .bancos-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; }
        .banco-card { background: #242427; border: 1px solid #3f3f46; border-radius: 8px; padding: 12px; text-align: center; opacity: 0.3; transition: all 0.3s ease; }
        .banco-card.ativo { opacity: 1; border-color: #04d361; box-shadow: 0 0 10px rgba(4, 211, 97, 0.2); }
        .banco-card h4 { margin: 0; font-size: 1.1rem; color: #fff; }
        .banco-card p { margin: 5px 0 0 0; font-size: 0.8rem; color: #a1a1aa; }
        .banco-card .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: bold; margin-top: 5px; background: #18181b; }
        
        .card-nubank { border-left: 4px solid #820ad1; }
        .card-inter { border-left: 4px solid #ff6600; }
        .card-itau { border-left: 4px solid #f97316; }
        .card-solana { border-left: 4px solid #14f195; }

        .status-sistema { background: #1c1917; border: 1px solid #444; padding: 10px; border-radius: 8px; text-align: center; font-style: italic; color: #fdba74; margin-bottom: 25px; }
        .controles { display: flex; gap: 15px; justify-content: center; margin-bottom: 30px; }
        button { background: #820ad1; color: #fff; border: none; padding: 12px 24px; font-size: 1rem; border-radius: 8px; cursor: pointer; font-weight: bold; }
        button.btn-sortear { background: #04d361; color: #121214; }
        button.btn-limpar { background: #27272a; color: #f4f4f5; border: 1px solid #3f3f46; }

        .grid-inferior { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .box { background: #18181b; padding: 20px; border-radius: 12px; border: 1px solid #27272a; height: 400px; overflow-y: auto; }
        .box h3 { margin-top: 0; color: #f4f4f5; font-size: 1.1rem; border-bottom: 1px solid #27272a; padding-bottom: 10px; display: flex; justify-content: space-between; }
        
        .log-item { background: #242427; padding: 12px; margin-bottom: 8px; border-radius: 6px; font-size: 0.95rem; display: flex; justify-content: space-between; align-items: center; }
        .log-item.fila { border-left: 4px solid #ff9000; background: #221502; color: #ffedd5; }
        .log-item.descartado { border-left: 4px solid #ef4444; background: #2d1010; color: #fca5a5; }
        
        .metric-tag { font-size: 0.75rem; padding: 2px 6px; border-radius: 4px; font-weight: bold; background: #18181b; border: 1px solid #3f3f46; }
        .banco-tag { margin-left: 5px; text-transform: uppercase; font-size: 0.7rem; }

        .vencedor-box { background: #820ad1; color: #fff; padding: 20px; border-radius: 12px; text-align: center; font-size: 1.5rem; font-weight: bold; margin-bottom: 25px; display: none; }
        .vencedor-box.confirmado { background: #04d361; color: #121214; }
        .vencedor-box.expirou { background: #ef4444; color: #fff; }
      </style>
    </head>
    <body>
      <h1>⚡ FlashSort Multiplex</h1>
      <h2 class="subtitle">Estratégia Drenagem Extrema (Porteira Aberta) para Lotes de 60s</h2>
      
      <div class="stats-topo">
        <div class="stat-card">
          <h4>Janela Lote</h4>
          <p id="tempo">01:00</p>
        </div>
        <div class="stat-card">
          <h4>Faturamento Líquido</h4>
          <p id="faturamento">R$ 0,00</p>
        </div>
      </div>

      <div class="bancos-container">
        <h3>Validadores e Chaveamento Automatizado</h3>
        <div class="bancos-grid">
          <div class="banco-card card-nubank ativo" id="card-Nubank">
            <h4>Nubank</h4>
            <p>Velocidade: 1.0s</p>
            <span class="badge" style="color: #a78bfa;">Taxa: 10%</span>
            <p style="font-size:0.7rem; color:#04d361; margin-top:5px;">Sempre Ativo</p>
          </div>
          <div class="banco-card card-inter" id="card-Inter">
            <h4>Inter</h4>
            <p>Velocidade: 0.5s</p>
            <span class="badge" style="color: #ff6600;">Taxa: 20%</span>
            <p style="font-size:0.65rem; color:#aaa; margin-top:5px;">Gatilho: Fila &ge; 10s</p>
          </div>
          <div class="banco-card card-itau" id="card-Itaú">
            <h4>Itaú</h4>
            <p>Velocidade: 0.5s</p>
            <span class="badge" style="color: #f97316;">Taxa: 30%</span>
            <p style="font-size:0.65rem; color:#aaa; margin-top:5px;">Gatilho: Fila &ge; 20s</p>
          </div>
          <div class="banco-card card-solana" id="card-SolanaPay">
            <h4>SolanaPay</h4>
            <p>Velocidade: Instantâneo</p>
            <span class="badge" style="color: #14f195;">Taxa: 80%</span>
            <p style="font-size:0.65rem; color:#aaa; margin-top:5px;">Gatilho: Fila &gt; 60s</p>
          </div>
        </div>
      </div>

      <div class="status-sistema" id="status-sistema">Aguardando abertura de inscrições...</div>

      <div class="controles">
        <button onclick="iniciarSorteio()">Abrir Lote (1 Lote)</button>
        <button class="btn-sortear" onclick="realizarSorteio()">🎉 Sortear Ticket</button>
        <button class="btn-limpar" onclick="limparTudo()">🗑️ Limpar Banco</button>
      </div>

      <div class="vencedor-box" id="vencedor-box"></div>

      <div class="grid-inferior">
        <div class="box">
          <h3>
            <span>⏳ Fila de Espera</span>
            <span style="color: #ff9000; font-weight: normal; font-size: 0.85rem;" id="tempo-espera-painel">Espera: 0s</span>
          </h3>
          <div id="fila-logs">Nenhum processo pendente...</div>
        </div>
        
        <div class="box">
          <h3>✅ Ledger de Validações</h3>
          <div id="atendidos-logs">Nenhuma transação efetuada...</div>
        </div>
      </div>

      <script>
        const evtSource = new EventSource('/painel-logs');

        evtSource.onmessage = function(event) {
          const dados = JSON.parse(event.data);
          
          if (dados.tipo === 'tempo') {
            document.getElementById('tempo').innerText = '00:' + String(dados.tempo).padStart(2, '0');
            document.getElementById('status-sistema').innerText = '🔥 Processando Lote. Fila: ' + dados.filaRestante;
            document.getElementById('tempo-espera-painel').innerText = 'Espera Estimada: ' + dados.tempoEspera + 's';
          }

          if (dados.tipo === 'status-bancos') {
            Object.keys(dados.bancos).forEach(chave => {
              const b = dados.bancos[chave];
              const card = document.getElementById('card-' + b.nome);
              if (card) {
                if (b.ativo) card.classList.add('ativo');
                else card.classList.remove('ativo');
              }
            });
          }
          
          if (dados.tipo === 'nova-requisicao') {
            const div = document.getElementById('fila-logs');
            if(div.innerHTML.includes('Nenhum processo')) div.innerHTML = '';
            document.getElementById('tempo-espera-painel').innerText = 'Espera Estimada: ' + dados.tempoEspera + 's';
            div.innerHTML += '<div class="log-item fila"><span>📥 Solicitante: <strong>' + dados.nome + '</strong></span><span class="metric-tag" style="color:#ff9000">Alocando...</span></div>';
          }
          
          if (dados.tipo === 'requisicao-processada') {
            const filaDiv = document.getElementById('fila-logs');
            if(filaDiv.firstChild) filaDiv.removeChild(filaDiv.firstChild);
            if(filaDiv.innerHTML === '') filaDiv.innerHTML = 'Fila vazia...';

            document.getElementById('tempo-espera-painel').innerText = 'Espera Estimada: ' + dados.tempoEspera + 's';

            const atendidosDiv = document.getElementById('atendidos-logs');
            if(atendidosDiv.innerHTML.includes('Nenhuma transação')) atendidosDiv.innerHTML = '';
            
            let corBanco = '#a78bfa';
            if(dados.banco === 'Inter') corBanco = '#ff6600';
            if(dados.banco === 'Itaú') corBanco = '#f97316';
            if(dados.banco === 'SolanaPay') corBanco = '#14f195';

            atendidosDiv.innerHTML = '<div class="log-item"><div>⚙️ <strong>' + dados.nome + '</strong> <span class="metric-tag banco-tag" style="color:'+corBanco+'; border-color:'+corBanco+'">' + dados.banco + '</span> <code style="background:#0c0c0e; padding:2px 6px; color:#ff9000; border-radius:4px; font-size:0.8rem; font-weight:bold">' + dados.chaveSecreta + '</code></div><span class="metric-tag">⏱️ Fila: ' + dados.tempoFila + 's | Taxa: R$ '+ dados.taxaCobranca.toFixed(2) +'</span></div>' + atendidosDiv.innerHTML;
            
            document.getElementById('faturamento').innerText = 'R$ ' + dados.lucroLiquido.toFixed(2).replace('.', ',');
          }

          if (dados.tipo === 'fim-tempo') {
            document.getElementById('tempo').innerText = '00:00';
            document.getElementById('status-sistema').innerText = dados.mensagem;
            document.getElementById('fila-logs').innerHTML = '<div class="log-item descartado">❌ Fila encerrada.</div>';
            document.getElementById('tempo-espera-painel').innerText = 'Espera: 0s';
            
            document.getElementById('card-Inter').classList.remove('ativo');
            document.getElementById('card-Itaú').classList.remove('ativo');
            document.getElementById('card-SolanaPay').classList.remove('ativo');
          }

          if (dados.tipo === 'ganhador-sorteado') {
            const box = document.getElementById('vencedor-box'); box.className = 'vencedor-box'; box.style.display = 'block';
            box.innerHTML = '🔔 Ticket #' + dados.ticket + ' (' + dados.nome + ') sorteado via ' + dados.banco + '! Valide em <span id="tempo-ganhador">60</span>s!';
          }
          if (dados.tipo === 'tempo-ganhador') { const tEl = document.getElementById('tempo-ganhador'); if(tEl) tEl.innerText = dados.tempo; }
          if (dados.tipo === 'ganhador-expirou') { const box = document.getElementById('vencedor-box'); box.className = 'vencedor-box expirou'; box.innerHTML = '❌ ' + dados.mensagem; }
          if (dados.tipo === 'ganhador-confirmado') { const box = document.getElementById('vencedor-box'); box.className = 'vencedor-box confirmado'; box.innerHTML = '🏆 VENCEDOR VALIDADO: ' + dados.nome + ' (Ticket #' + dados.ticket + ')! 🏆'; }

          if (dados.tipo === 'limpar-tela') {
            document.getElementById('tempo').innerText = '01:00';
            document.getElementById('faturamento').innerText = 'R$ 0,00';
            document.getElementById('status-sistema').innerText = 'Aguardando abertura de inscrições...';
            document.getElementById('fila-logs').innerHTML = 'Nenhum processo pendente...';
            document.getElementById('atendidos-logs').innerHTML = 'Nenhuma transação efetuada...';
            document.getElementById('vencedor-box').style.display = 'none';
            document.getElementById('tempo-espera-painel').innerText = 'Espera: 0s';
            
            // Corrige o front para apagar o estilo ativo dos cards na hora do reset
            document.getElementById('card-Inter').classList.remove('ativo');
            document.getElementById('card-Itaú').classList.remove('ativo');
            document.getElementById('card-SolanaPay').classList.remove('ativo');
          }
        };

        async function iniciarSorteio() { await fetch('/painel/iniciar', { method: 'POST' }); }
        async function realizarSorteio() { await fetch('/painel/sortear'); }
        async function limparTudo() { await fetch('/painel/limpar', { method: 'POST' }); }
      </script>
    </body>
    </html>
  `);
});

app.listen(PORT, () => console.log(`[FlashSort] Cluster rodando com Drenagem Total na porta ${PORT}`));
