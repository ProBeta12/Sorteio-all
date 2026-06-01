import express from 'express';
import sqlite3 from 'sqlite3';
import crypto from 'crypto';
import cors from 'cors';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const db = new sqlite3.Database(':memory:');

// Banco de dados adaptado com auditoria financeira e status de transação (Aprovado / Rejeitado)
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
let faturamentoLiquido = 0; // Guarda o valor já retirando os 10% do banco

let ganhadorAtual = null;
let tempoConfirmacaoGanhador = 0;
let intervaloGanhador = null;

// O Nubank processa 1 requisição por segundo tirando sua taxa de 10%
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

      // Regra de Negócio: Taxa de 10% do validador bancário
      const valorOriginal = 2.00;
      const taxaBanco = valorOriginal * 0.10; // R$ 0,20
      const valorLiquido = valorOriginal - taxaBanco; // R$ 1,80

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

            // 1. Atualiza o painel visual
            enviarParaPainel({
              tipo: 'requisicao-processada',
              ...dadosTicket,
              filaRestante: filaEspera.length
            });

            // 2. Responde a requisição HTTP original
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

// 1. Rota de Compra de Ticket
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

// Rota Analítica atualizada para você puxar o relatório completo incluindo Rejeitados
app.get('/painel/dados-analise', (req, res) => {
  db.all('SELECT * FROM participantes', [], (err, rows) => {
    if (err) return res.status(500).json({ erro: err.message });
    res.json(rows);
  });
});

// 2. Iniciar Lote do Sorteio
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

      // Percorre e salva no banco de dados todos os usuários que foram rejeitados por estouro de tempo
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

// 3. Sortear Vencedor (Filtra para sortear APENAS quem foi APROVADO)
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

// 4. Confirmar Prêmio
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

// 5. Limpar Tudo
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

// 6. Painel HTML Atualizado
app.get('/painel', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <title>FlashSort - Dashboard Financeiro</title>
      <style>
        body { font-family: system-ui, sans-serif; background: #0c0c0e; color: #f5f5f7; padding: 20px; max-width: 1100px; margin: 0 auto; }
        h1 { color: #820ad1; text-align: center; margin-bottom: 5px; font-weight: 800; }
        h2.subtitle { text-align: center; color: #a8a8b3; font-size: 1.1rem; margin-top: 0; margin-bottom: 25px; font-weight: 400; }
        
        .stats-topo { display: flex; gap: 20px; justify-content: center; margin: 15px 0; }
        .stat-card { background: #18181b; border: 1px solid #27272a; padding: 10px 25px; border-radius: 12px; text-align: center; min-width: 180px; }
        .stat-card h4 { margin: 0; color: #a1a1aa; font-size: 0.85rem; text-transform: uppercase; }
        .stat-card p { margin: 5px 0 0 0; font-size: 2rem; font-weight: bold; }
        #tempo { color: #ff9000; }
        #faturamento { color: #04d361; }

        .bancos-container { background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 12px; margin-bottom: 25px; }
        .bancos-grid { display: flex; justify-content: center; }
        .banco-card { background: #242427; border: 1px solid #3f3f46; border-radius: 8px; padding: 10px 30px; text-align: center; font-weight: bold; border-left: 5px solid #820ad1; }
        .banco-card .status-dot { width: 9px; height: 9px; background: #a1a1aa; border-radius: 50%; display: inline-block; margin-right: 8px; }
        .banco-card.ativo .status-dot { background: #04d361; box-shadow: 0 0 8px #04d361; }
        .banco-info { font-size: 0.85rem; color: #a1a1aa; font-weight: normal; margin-top: 4px; }

        .status-sistema { background: #1c1917; border: 1px solid #444; padding: 10px; border-radius: 8px; text-align: center; font-style: italic; color: #fdba74; margin-bottom: 25px; }
        .controles { display: flex; gap: 15px; justify-content: center; margin-bottom: 30px; }
        button { background: #820ad1; color: #fff; border: none; padding: 12px 24px; font-size: 1rem; border-radius: 8px; cursor: pointer; font-weight: bold; transition: opacity 0.2s; }
        button:hover { opacity: 0.9; }
        button.btn-sortear { background: #04d361; color: #121214; }
        button.btn-limpar { background: #27272a; color: #f4f4f5; border: 1px solid #3f3f46; }

        .grid-inferior { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .box { background: #18181b; padding: 20px; border-radius: 12px; border: 1px solid #27272a; height: 400px; overflow-y: auto; }
        .box h3 { margin-top: 0; color: #f4f4f5; font-size: 1.1rem; border-bottom: 1px solid #27272a; padding-bottom: 10px; display: flex; justify-content: space-between; }
        
        .log-item { background: #242427; padding: 12px; margin-bottom: 8px; border-left: 4px solid #820ad1; border-radius: 6px; font-size: 0.95rem; display: flex; justify-content: space-between; align-items: center; }
        .log-item.fila { border-left-color: #ff9000; background: #221502; color: #ffedd5; }
        .log-item.descartado { border-left-color: #ef4444; background: #2d1010; color: #fca5a5; }
        
        .metric-tag { font-size: 0.75rem; padding: 2px 6px; border-radius: 4px; font-weight: bold; background: #18181b; border: 1px solid #3f3f46; color: #a78bfa; }
        .taxa-tag { color: #fca5a5; border-color: #ef4444; font-size: 0.7rem; margin-left: 8px; text-transform: uppercase;}
        .tempo-acumulado-header { font-size: 0.85rem; color: #ff9000; font-weight: normal; }

        .vencedor-box { background: #820ad1; color: #fff; padding: 20px; border-radius: 12px; text-align: center; font-size: 1.5rem; font-weight: bold; margin-bottom: 25px; display: none; }
        .vencedor-box.confirmado { background: #04d361; color: #121214; }
        .vencedor-box.expirou { background: #ef4444; color: #fff; }
      </style>
    </head>
    <body>
      <h1>⚡ FlashSort</h1>
      <h2 class="subtitle">Taxas do Nubank (10%) & Auditoria de Leads Rejeitados</h2>
      
      <div class="stats-topo">
        <div class="stat-card">
          <h4>Janela Lote</h4>
          <p id="tempo">01:00</p>
        </div>
        <div class="stat-card">
          <h4>Faturamento Líquido (-10%)</h4>
          <p id="faturamento">R$ 0,00</p>
        </div>
      </div>

      <div class="bancos-container">
        <div class="bancos-grid">
          <div class="banco-card" id="banco-Nubank">
            <span class="status-dot"></span>Validador Ativo: Nubank
            <div class="banco-info">Tempo de Resposta: 1.0s fixo | Taxa de Rede: 10%</div>
          </div>
        </div>
      </div>

      <div class="status-sistema" id="status-sistema">FlashSort pronto para operação.</div>

      <div class="controles">
        <button onclick="iniciarSorteio()">Abrir Lote de Inscrição (1 Min)</button>
        <button class="btn-sortear" onclick="realizarSorteio()">🎉 Sortear Vencedor</button>
        <button class="btn-limpar" onclick="limparTudo()">🗑️ Reiniciar Painel</button>
      </div>

      <div class="vencedor-box" id="vencedor-box"></div>

      <div class="grid-inferior">
        <div class="box">
          <h3>
            <span>⏳ Fila de Processamento</span>
            <span class="tempo-acumulado-header" id="tempo-acumulado-fila">Espera total: 0s</span>
          </h3>
          <div id="fila-logs">Nenhuma requisição na fila...</div>
        </div>
        
        <div class="box">
          <h3>✅ Pagamentos Processados (Sucesso)</h3>
          <div id="atendidos-logs">Nenhum pagamento processado ainda...</div>
        </div>
      </div>

      <script>
        const evtSource = new EventSource('/painel-logs');
        let contadorFilaLocal = 0;

        function atualizarPainelBanco(ativo) {
          const el = document.getElementById('banco-Nubank');
          if(ativo) el.classList.add('ativo');
          else el.classList.remove('ativo');
        }

        function atualizarTempoAcumuladoFila() {
          document.getElementById('tempo-acumulado-fila').innerText = 'Espera total aproximada: ' + contadorFilaLocal + 's';
        }

        evtSource.onmessage = function(event) {
          const dados = JSON.parse(event.data);
          
          if (dados.tipo === 'tempo') {
            document.getElementById('tempo').innerText = '00:' + String(dados.tempo).padStart(2, '0');
            document.getElementById('status-sistema').innerText = '🔥 Lote ativo. Fila de processamento: ' + dados.filaRestante;
            atualizarPainelBanco(true);
          }
          
          if (dados.tipo === 'status-sistema') {
            document.getElementById('status-sistema').innerText = dados.mensagem;
          }
          
          if (dados.tipo === 'nova-requisicao') {
            const div = document.getElementById('fila-logs');
            if(div.innerHTML.includes('Nenhuma requisição')) div.innerHTML = '';
            
            contadorFilaLocal = dados.filaRestante;
            atualizarTempoAcumuladoFila();

            div.innerHTML += '<div class="log-item fila"><span>💳 Pix recebido: <strong>' + dados.nome + '</strong></span><span class="metric-tag" style="color: #ff9000; border-color: #ff9000">Processando...</span></div>';
          }
          
          if (dados.tipo === 'requisicao-processada') {
            const filaDiv = document.getElementById('fila-logs');
            if(filaDiv.firstChild) filaDiv.removeChild(filaDiv.firstChild);
            if(filaDiv.innerHTML === '') filaDiv.innerHTML = 'Nenhuma requisição na fila...';

            contadorFilaLocal = dados.filaRestante;
            atualizarTempoAcumuladoFila();

            const atendidosDiv = document.getElementById('atendidos-logs');
            if(atendidosDiv.innerHTML.includes('Nenhum pagamento')) atendidosDiv.innerHTML = '';
            
            atendidosDiv.innerHTML = '<div class="log-item"><div>⚙️ <strong>' + dados.nome + '</strong> | TICKET #' + dados.ticket + ' <span class="metric-tag taxa-tag">-R$0,20 Nubank</span></div><span class="metric-tag">⏱️ ' + dados.tempoFila + 's na fila</span></div>' + atendidosDiv.innerHTML;
            
            document.getElementById('faturamento').innerText = 'R$ ' + dados.lucroLiquido.toFixed(2).replace('.', ',');
            document.getElementById('status-sistema').innerText = '🔥 Lote ativo. Fila de processamento: ' + dados.filaRestante;
          }

          if (dados.tipo === 'fim-tempo') {
            document.getElementById('tempo').innerText = '00:00';
            document.getElementById('status-sistema').innerText = dados.mensagem;
            document.getElementById('fila-logs').innerHTML = '<div class="log-item descartado">❌ Lote encerrado! Pedidos excedentes arquivados como REJEITADOS.</div>';
            contadorFilaLocal = 0;
            atualizarTempoAcumuladoFila();
            atualizarPainelBanco(false);
          }

          if (dados.tipo === 'ganhador-sorteado') {
            const box = document.getElementById('vencedor-box');
            box.className = 'vencedor-box';
            box.style.display = 'block';
            box.innerHTML = '🔔 Ticket #' + dados.ticket + ' (' + dados.nome + ') sorteado! Valide em <span id="tempo-ganhador">60</span>s!';
          }

          if (dados.tipo === 'tempo-ganhador') {
            const tEl = document.getElementById('tempo-ganhador');
            if(tEl) tEl.innerText = dados.tempo;
          }

          if (dados.tipo === 'ganhador-expirou') {
            const box = document.getElementById('vencedor-box');
            box.className = 'vencedor-box expirou';
            box.innerHTML = '❌ ' + dados.mensagem;
          }

          if (dados.tipo === 'ganhador-confirmado') {
            const box = document.getElementById('vencedor-box');
            box.className = 'vencedor-box confirmado';
            box.innerHTML = '🏆 PARABÉNS! ' + dados.nome + ' (Ticket #' + dados.ticket + ') validou a assinatura do prêmio! 🏆';
          }

          if (dados.tipo === 'limpar-tela') {
            document.getElementById('tempo').innerText = '01:00';
            document.getElementById('faturamento').innerText = 'R$ 0,00';
            document.getElementById('status-sistema').innerText = 'FlashSort pronto para operação.';
            document.getElementById('fila-logs').innerHTML = 'Nenhuma requisição na fila...';
            document.getElementById('atendidos-logs').innerHTML = 'Nenhum pagamento processado ainda...';
            document.getElementById('vencedor-box').style.display = 'none';
            contadorFilaLocal = 0;
            atualizarTempoAcumuladoFila();
            atualizarPainelBanco(false);
          }
        };

        async function iniciarSorteio() {
          await fetch('/painel/iniciar', { method: 'POST' });
        }

        async function realizarSorteio() {
          await fetch('/painel/sortear');
        }

        async function limparTudo() {
          await fetch('/painel/limpar', { method: 'POST' });
        }
      </script>
    </body>
    </html>
  `);
});

app.listen(PORT, () => console.log(`[FlashSort] Servidor rodando com sucesso na porta ${PORT}`));
