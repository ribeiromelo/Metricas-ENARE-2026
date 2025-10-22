-- ====================================================
-- ADICIONAR ROLE DE ADMINISTRADOR
-- ====================================================

-- Adicionar coluna is_admin na tabela usuarios
ALTER TABLE usuarios ADD COLUMN is_admin BOOLEAN DEFAULT 0;

-- Criar índice para buscar admins rapidamente
CREATE INDEX IF NOT EXISTS idx_usuarios_admin ON usuarios(is_admin);
