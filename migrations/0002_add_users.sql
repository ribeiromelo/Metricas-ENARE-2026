-- ====================================================
-- ADICIONAR SISTEMA DE USUÁRIOS E AUTENTICAÇÃO
-- ====================================================

-- Tabela de Usuários
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  senha_hash TEXT NOT NULL,
  nome TEXT NOT NULL,
  data_prova DATE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME
);

-- Adicionar coluna usuario_id nas tabelas existentes
ALTER TABLE configuracoes ADD COLUMN usuario_id INTEGER REFERENCES usuarios(id);
ALTER TABLE semanas ADD COLUMN usuario_id INTEGER REFERENCES usuarios(id);
ALTER TABLE estudos ADD COLUMN usuario_id INTEGER REFERENCES usuarios(id);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);
CREATE INDEX IF NOT EXISTS idx_configuracoes_usuario ON configuracoes(usuario_id);
CREATE INDEX IF NOT EXISTS idx_semanas_usuario ON semanas(usuario_id);
CREATE INDEX IF NOT EXISTS idx_estudos_usuario ON estudos(usuario_id);

-- Tabela de Sessões (para autenticação)
CREATE TABLE IF NOT EXISTS sessoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
);

CREATE INDEX IF NOT EXISTS idx_sessoes_token ON sessoes(token);
CREATE INDEX IF NOT EXISTS idx_sessoes_usuario ON sessoes(usuario_id);

-- Tabela de Metas de Estudo (configurações flexíveis)
CREATE TABLE IF NOT EXISTS metas_estudo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL UNIQUE,
  meta_ideal_horas INTEGER DEFAULT 4,
  meta_ideal_temas INTEGER DEFAULT 4,
  meta_realista_horas INTEGER DEFAULT 3,
  meta_realista_temas INTEGER DEFAULT 3,
  meta_sobrevivencia_horas INTEGER DEFAULT 2,
  meta_sobrevivencia_temas INTEGER DEFAULT 2,
  meta_atual TEXT DEFAULT 'ideal', -- 'ideal', 'realista', 'sobrevivencia'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
);

CREATE INDEX IF NOT EXISTS idx_metas_usuario ON metas_estudo(usuario_id);
