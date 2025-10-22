-- ====================================================
-- CICLOS DE ESTUDO ADAPTATIVOS
-- ====================================================

-- Tabela de ciclos de estudo personalizados
CREATE TABLE IF NOT EXISTS ciclos_estudo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL,
  tipo_ciclo TEXT NOT NULL CHECK(tipo_ciclo IN ('extensivo', 'semi-intensivo', 'intensivo')),
  semanas_planejadas INTEGER NOT NULL,
  semanas_reais INTEGER NOT NULL,
  data_inicio DATE NOT NULL,
  data_prova DATE NOT NULL,
  status TEXT DEFAULT 'ativo' CHECK(status IN ('ativo', 'pausado', 'concluido', 'cancelado')),
  temas_alta INTEGER DEFAULT 0,
  temas_media INTEGER DEFAULT 0,
  temas_baixa INTEGER DEFAULT 0,
  progresso_atual INTEGER DEFAULT 0,
  adaptacao_automatica BOOLEAN DEFAULT 1,
  mensagem_alerta TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
);

-- Tabela de semanas do ciclo (detalhamento semanal)
CREATE TABLE IF NOT EXISTS ciclo_semanas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ciclo_id INTEGER NOT NULL,
  numero_semana INTEGER NOT NULL,
  data_inicio DATE NOT NULL,
  data_fim DATE NOT NULL,
  status TEXT DEFAULT 'pendente' CHECK(status IN ('pendente', 'em_andamento', 'concluida')),
  temas_planejados INTEGER DEFAULT 0,
  temas_concluidos INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ciclo_id) REFERENCES ciclos_estudo(id),
  UNIQUE(ciclo_id, numero_semana)
);

-- Tabela de temas por semana do ciclo
CREATE TABLE IF NOT EXISTS ciclo_semana_temas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ciclo_semana_id INTEGER NOT NULL,
  tema_id INTEGER NOT NULL,
  ordem INTEGER NOT NULL,
  status TEXT DEFAULT 'pendente' CHECK(status IN ('pendente', 'em_andamento', 'concluido')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ciclo_semana_id) REFERENCES ciclo_semanas(id),
  FOREIGN KEY (tema_id) REFERENCES temas(id),
  UNIQUE(ciclo_semana_id, tema_id)
);

-- Tornar data_prova NOT NULL na tabela usuarios (se ainda não for)
-- Nota: SQLite não suporta ALTER COLUMN, então vamos adicionar constraint via trigger

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_ciclos_usuario ON ciclos_estudo(usuario_id, status);
CREATE INDEX IF NOT EXISTS idx_ciclo_semanas_ciclo ON ciclo_semanas(ciclo_id, numero_semana);
CREATE INDEX IF NOT EXISTS idx_ciclo_semana_temas_semana ON ciclo_semana_temas(ciclo_semana_id);
