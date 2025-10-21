-- ====================================================
-- CÉREBRO DE ESTUDOS HARDMED - Schema Inicial
-- ====================================================

-- Tabela de Temas (importados do Excel)
CREATE TABLE IF NOT EXISTS temas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  area TEXT NOT NULL,
  subarea TEXT NOT NULL,
  tema TEXT NOT NULL,
  subtopicos TEXT,
  prevalencia TEXT NOT NULL, -- ALTA, MÉDIA, BAIXA
  prevalencia_numero INTEGER NOT NULL, -- 5, 3, 1
  prioridade INTEGER,
  origem TEXT,
  observacoes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de Configurações do Usuário
CREATE TABLE IF NOT EXISTS configuracoes (
  id INTEGER PRIMARY KEY CHECK (id = 1), -- Apenas 1 registro
  horas_por_dia INTEGER DEFAULT 4,
  temas_por_dia INTEGER DEFAULT 4,
  data_prova DATE,
  semana_atual INTEGER DEFAULT 1,
  ciclo_gerado BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Inserir configuração padrão
INSERT OR IGNORE INTO configuracoes (id, horas_por_dia, temas_por_dia, data_prova)
VALUES (1, 4, 4, date('now', '+280 days'));

-- Tabela de Semanas (40 semanas do ciclo)
CREATE TABLE IF NOT EXISTS semanas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero_semana INTEGER NOT NULL UNIQUE,
  data_inicio DATE,
  data_fim DATE,
  concluida BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de Relação Semana-Tema (4 temas por semana)
CREATE TABLE IF NOT EXISTS semana_temas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  semana_id INTEGER NOT NULL,
  tema_id INTEGER NOT NULL,
  ordem INTEGER NOT NULL, -- 1, 2, 3, 4 (ordem do tema na semana)
  metodo TEXT DEFAULT 'questoes', -- 'questoes' ou 'teoria'
  meta_questoes INTEGER DEFAULT 15,
  meta_tempo_minutos INTEGER DEFAULT 60,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (semana_id) REFERENCES semanas(id),
  FOREIGN KEY (tema_id) REFERENCES temas(id),
  UNIQUE(semana_id, tema_id)
);

-- Tabela de Estudos Realizados
CREATE TABLE IF NOT EXISTS estudos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tema_id INTEGER NOT NULL,
  semana_tema_id INTEGER,
  data_estudo DATE NOT NULL,
  metodo TEXT NOT NULL, -- 'questoes' ou 'teoria'
  questoes_feitas INTEGER DEFAULT 0,
  questoes_acertos INTEGER DEFAULT 0,
  acuracia REAL DEFAULT 0, -- Percentual de acertos
  tempo_minutos INTEGER DEFAULT 0,
  observacoes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tema_id) REFERENCES temas(id),
  FOREIGN KEY (semana_tema_id) REFERENCES semana_temas(id)
);

-- Tabela de Revisões (sistema de revisão espaçada)
CREATE TABLE IF NOT EXISTS revisoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estudo_id INTEGER NOT NULL,
  tema_id INTEGER NOT NULL,
  numero_revisao INTEGER NOT NULL, -- 1, 2, 3, 4, 5...
  data_agendada DATE NOT NULL,
  data_realizada DATE,
  intervalo_dias INTEGER NOT NULL, -- Intervalo usado (1, 3, 7, 15, 30...)
  acuracia_revisao REAL,
  concluida BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (estudo_id) REFERENCES estudos(id),
  FOREIGN KEY (tema_id) REFERENCES temas(id)
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_temas_area ON temas(area);
CREATE INDEX IF NOT EXISTS idx_temas_prevalencia ON temas(prevalencia_numero);
CREATE INDEX IF NOT EXISTS idx_estudos_tema ON estudos(tema_id);
CREATE INDEX IF NOT EXISTS idx_estudos_data ON estudos(data_estudo);
CREATE INDEX IF NOT EXISTS idx_revisoes_tema ON revisoes(tema_id);
CREATE INDEX IF NOT EXISTS idx_revisoes_agendada ON revisoes(data_agendada, concluida);
CREATE INDEX IF NOT EXISTS idx_semana_temas_semana ON semana_temas(semana_id);
