-- ====================================================
-- CORRIGIR CONSTRAINT UNIQUE DA TABELA SEMANAS
-- Permitir múltiplos usuários com mesmos números de semana
-- ====================================================

-- SQLite não suporta ALTER TABLE para modificar constraints
-- Precisamos recriar a tabela

-- 1. Criar nova tabela com UNIQUE composto (numero_semana, usuario_id)
CREATE TABLE IF NOT EXISTS semanas_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero_semana INTEGER NOT NULL,
  usuario_id INTEGER NOT NULL,
  data_inicio DATE,
  data_fim DATE,
  concluida BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id),
  UNIQUE(numero_semana, usuario_id)
);

-- 2. Copiar dados existentes (apenas se houver usuario_id preenchido)
INSERT INTO semanas_new (id, numero_semana, usuario_id, data_inicio, data_fim, concluida, created_at)
SELECT id, numero_semana, usuario_id, data_inicio, data_fim, concluida, created_at
FROM semanas
WHERE usuario_id IS NOT NULL;

-- 3. Remover tabela antiga
DROP TABLE semanas;

-- 4. Renomear nova tabela
ALTER TABLE semanas_new RENAME TO semanas;

-- 5. Recriar índices
CREATE INDEX IF NOT EXISTS idx_semanas_usuario ON semanas(usuario_id);
CREATE INDEX IF NOT EXISTS idx_semanas_numero ON semanas(numero_semana);
