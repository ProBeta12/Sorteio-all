import express from 'express';
import sqlite3 from 'sqlite3';

const app = express();
const PORT = 3000;

app.use(express.json());

// 1. Conecta ao banco de dados (vai criar um arquivo chamado 'sorteio.db' automaticamente)
const db = new sqlite3.Database('./sorteio.db', (err) => {
  if (err) console.error('Erro ao conectar ao banco:', err.message);
  else console.log('Conectado ao banco de dados SQLite.');
});

// 2. Cria a tabela de participantes se ela ainda não existir
db.run(`
  CREATE TABLE IF NOT EXISTS participantes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    comprado INTEGER DEFAULT 1
  )
`);

// Rota GET: Puxa todos os participantes salvos no banco de dados
app.get('/participantes', (req, res) => {
  db.all('SELECT * FROM participantes', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ erro: err.message });
    }
    // Mapeia os dados para ficarem no formato bonitinho que você tinha antes
    const listaFormatada = rows.map(row => ({
      nome: row.nome,
      ticket: row.id, // O ID autoincremento do banco vira o número do ticket
      comprado: row.comprado === 1
    }));
    res.json(listaFormatada);
  });
});

// Rota POST: Insere o nome no banco de dados de forma ultra rápida
app.post('/comprar-ticket', (req, res) => {
  const { nome } = req.body;

  if (!nome || nome.trim() === "") {
    return res.status(400).send('Por favor, informe um nome válido.');
  }

  // Insere o nome. O SQLite calcula o ID/Ticket sozinho, mesmo com requisições simultâneas
  const query = 'INSERT INTO participantes (nome) VALUES (?)';
  
  db.run(query, [nome], function(err) {
    if (err) {
      return res.status(500).json({ erro: err.message });
    }

    // "this.lastID" contém o ID que acabou de ser gerado pelo banco para esse usuário
    res.status(201).json({
      mensagem: 'Ticket gerado com sucesso!',
      dados: {
        nome: nome,
        ticket: this.lastID,
        comprado: true
      }
    });
  });
});

app.listen(PORT, () => {
  console.log(`Servidor de alta performance rodando na porta ${PORT}`);
});
