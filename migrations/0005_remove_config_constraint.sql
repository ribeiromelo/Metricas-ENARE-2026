-- ====================================================
-- REMOVER CONSTRAINT id = 1 DA TABELA CONFIGURACOES
-- ====================================================

-- SQLite não suporta ALTER TABLE para remover constraints
-- Precisamos recriar a tabela

-- 1. Criar nova tabela sem o constraint
CREATE TABLE IF NOT EXISTS configuracoes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER,
  horas_por_dia INTEGER DEFAULT 4,
  temas_por_dia INTEGER DEFAULT 4,
  data_prova DATE,
  semana_atual INTEGER DEFAULT 1,
  ciclo_gerado BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
);

-- 2. Copiar dados existentes (se houver)
INSERT INTO configuracoes_new (id, usuario_id, horas_por_dia, temas_por_dia, data_prova, semana_atual, ciclo_gerado, created_at, updated_at)
SELECT id, usuario_id, horas_por_dia, temas_por_dia, data_prova, semana_atual, ciclo_gerado, created_at, updated_at
FROM configuracoes;

-- 3. Remover tabela antiga
DROP TABLE configuracoes;

-- 4. Renomear nova tabela
ALTER TABLE configuracoes_new RENAME TO configuracoes;

-- 5. Criar índice
CREATE INDEX IF NOT EXISTS idx_configuracoes_usuario ON configuracoes(usuario_id);
