-- ====================================================
-- CORRIGIR CONSTRAINT UNIQUE DA TABELA SEMANAS
-- ====================================================

-- Remover UNIQUE constraint de numero_semana
-- SQLite não suporta ALTER TABLE para modificar constraints
-- Então precisamos recriar a tabela

-- 1. Criar tabela temporária sem a constraint UNIQUE
CREATE TABLE IF NOT EXISTS semanas_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero_semana INTEGER NOT NULL,
  data_inicio DATE,
  data_fim DATE,
  concluida INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  usuario_id INTEGER REFERENCES usuarios(id)
);

-- 2. Copiar dados existentes (se houver)
INSERT INTO semanas_new (id, numero_semana, data_inicio, data_fim, concluida, created_at, usuario_id)
SELECT id, numero_semana, data_inicio, data_fim, concluida, created_at, usuario_id
FROM semanas;

-- 3. Remover tabela antiga
DROP TABLE semanas;

-- 4. Renomear nova tabela
ALTER TABLE semanas_new RENAME TO semanas;

-- 5. Recriar índices
CREATE INDEX IF NOT EXISTS idx_semanas_usuario ON semanas(usuario_id);
CREATE INDEX IF NOT EXISTS idx_semanas_numero_usuario ON semanas(numero_semana, usuario_id);
