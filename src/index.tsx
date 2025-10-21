import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

// Types
type Bindings = {
  DB: D1Database
}

type Tema = {
  id: number
  area: string
  subarea: string
  tema: string
  subtopicos: string
  prevalencia: string
  prevalencia_numero: number
  prioridade: number
}

type Semana = {
  id: number
  numero_semana: number
  data_inicio: string
  data_fim: string
  concluida: number
}

type SemanaTema = {
  id: number
  semana_id: number
  tema_id: number
  ordem: number
  metodo: string
  meta_questoes: number
  meta_tempo_minutos: number
}

const app = new Hono<{ Bindings: Bindings }>()

// CORS para API
app.use('/api/*', cors())

// ====================================================
// API: GERADOR DE CICLO DE 40 SEMANAS
// ====================================================
app.post('/api/ciclo/gerar', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const usuarioId = auth.usuario.usuario_id
  
  try {
    // 1. Verificar se já existe ciclo gerado para este usuário
    const configResult = await DB.prepare('SELECT ciclo_gerado FROM configuracoes WHERE usuario_id = ?')
      .bind(usuarioId).first()
    if (configResult && configResult.ciclo_gerado) {
      return c.json({ error: 'Ciclo já foi gerado' }, 400)
    }

    // 2. Buscar todos os temas ordenados por prevalência e área
    const temasResult = await DB.prepare(`
      SELECT * FROM temas 
      ORDER BY prevalencia_numero DESC, area, id
    `).all()

    const temas = temasResult.results as Tema[]
    
    if (temas.length === 0) {
      return c.json({ error: 'Nenhum tema encontrado' }, 400)
    }

    // 3. Agrupar por área
    const temasPorArea: { [key: string]: Tema[] } = {}
    temas.forEach(tema => {
      if (!temasPorArea[tema.area]) {
        temasPorArea[tema.area] = []
      }
      temasPorArea[tema.area].push(tema)
    })

    // 4. Gerar 40 semanas
    const NUMERO_SEMANAS = 40
    const TEMAS_POR_SEMANA = 4
    const semanasGeradas: Array<{ semana: number, temas: Tema[] }> = []
    
    // Criar índices para cada área
    const indices: { [key: string]: number } = {}
    Object.keys(temasPorArea).forEach(area => {
      indices[area] = 0
    })

    const areas = Object.keys(temasPorArea)
    let areaIndex = 0

    // Distribuir temas em 40 semanas
    for (let semana = 1; semana <= NUMERO_SEMANAS; semana++) {
      const temasDaSemana: Tema[] = []
      
      for (let i = 0; i < TEMAS_POR_SEMANA; i++) {
        // Rotacionar áreas
        let tentativas = 0
        while (tentativas < areas.length) {
          const areaAtual = areas[areaIndex % areas.length]
          const temasDaArea = temasPorArea[areaAtual]
          
          if (indices[areaAtual] < temasDaArea.length) {
            temasDaSemana.push(temasDaArea[indices[areaAtual]])
            indices[areaAtual]++
            areaIndex++
            break
          } else {
            areaIndex++
            tentativas++
          }
        }

        // Se todas as áreas acabaram, parar
        if (tentativas >= areas.length) {
          break
        }
      }

      if (temasDaSemana.length > 0) {
        semanasGeradas.push({ semana, temas: temasDaSemana })
      }
    }

    // 5. Inserir no banco
    const hoje = new Date().toISOString().split('T')[0]
    
    for (const sg of semanasGeradas) {
      // Inserir semana
      const semanaResult = await DB.prepare(`
        INSERT INTO semanas (numero_semana, data_inicio, data_fim, usuario_id) 
        VALUES (?, ?, ?, ?)
      `).bind(sg.semana, hoje, hoje, usuarioId).run()

      const semanaId = semanaResult.meta.last_row_id

      // Inserir relação semana-tema
      for (let i = 0; i < sg.temas.length; i++) {
        const tema = sg.temas[i]
        const metodo = ['Clínica Médica', 'Cirurgia Geral', 'Obstetrícia', 'Ginecologia'].includes(tema.area) ? 'questoes' : 'teoria'
        
        await DB.prepare(`
          INSERT INTO semana_temas (semana_id, tema_id, ordem, metodo, meta_questoes, meta_tempo_minutos)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(semanaId, tema.id, i + 1, metodo, 15, 60).run()
      }
    }

    // 6. Atualizar configuração
    await DB.prepare('UPDATE configuracoes SET ciclo_gerado = 1 WHERE usuario_id = ?').bind(usuarioId).run()

    return c.json({ 
      success: true, 
      message: `Ciclo de ${semanasGeradas.length} semanas gerado com sucesso`,
      semanas: semanasGeradas.length,
      temas_distribuidos: semanasGeradas.reduce((acc, s) => acc + s.temas.length, 0)
    })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// ====================================================
// API: BUSCAR SEMANA ATUAL
// ====================================================
app.get('/api/semana/atual', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const usuarioId = auth.usuario.usuario_id
  
  try {
    const config = await DB.prepare('SELECT semana_atual FROM configuracoes WHERE usuario_id = ?')
      .bind(usuarioId).first()
    const semanaAtual = config?.semana_atual || 1

    const semana = await DB.prepare(`
      SELECT * FROM semanas WHERE numero_semana = ? AND usuario_id = ?
    `).bind(semanaAtual, usuarioId).first() as Semana

    if (!semana) {
      return c.json({ error: 'Semana não encontrada' }, 404)
    }

    // CRITICAL FIX: Buscar temas da semana e verificar quais já foram estudados
    // Adiciona coluna 'ja_estudado' (COUNT de estudos para cada tema)
    const temasResult = await DB.prepare(`
      SELECT st.*, t.*, 
        (SELECT COUNT(*) FROM estudos e WHERE e.semana_tema_id = st.id) as ja_estudado
      FROM semana_temas st
      INNER JOIN temas t ON st.tema_id = t.id
      WHERE st.semana_id = ?
      ORDER BY st.ordem
    `).bind(semana.id).all()

    // Filtrar para mostrar APENAS temas não estudados na homepage
    const temasNaoEstudados = temasResult.results.filter((t: any) => t.ja_estudado === 0)

    return c.json({
      semana,
      temas: temasNaoEstudados, // Apenas temas não estudados
      todos_temas: temasResult.results // Todos os temas (para referência se necessário)
    })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// ====================================================
// API: LISTAR TODAS AS SEMANAS
// ====================================================
app.get('/api/semanas', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const usuarioId = auth.usuario.usuario_id
  
  try {
    const semanasResult = await DB.prepare(`
      SELECT s.*, 
        COUNT(st.id) as total_temas,
        SUM(CASE WHEN EXISTS(
          SELECT 1 FROM estudos e 
          WHERE e.semana_tema_id = st.id AND e.usuario_id = ?
        ) THEN 1 ELSE 0 END) as temas_concluidos
      FROM semanas s
      LEFT JOIN semana_temas st ON st.semana_id = s.id
      WHERE s.usuario_id = ?
      GROUP BY s.id
      ORDER BY s.numero_semana
    `).bind(usuarioId, usuarioId).all()

    return c.json({ semanas: semanasResult.results })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// ====================================================
// API: OBTER TEMAS DE UMA SEMANA ESPECÍFICA
// ====================================================
app.get('/api/semana/:numero', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const usuarioId = auth.usuario.usuario_id
  const numeroSemana = parseInt(c.req.param('numero'))
  
  try {
    const semana = await DB.prepare(`
      SELECT * FROM semanas 
      WHERE numero_semana = ? AND usuario_id = ?
    `).bind(numeroSemana, usuarioId).first()
    
    if (!semana) {
      return c.json({ error: 'Semana não encontrada' }, 404)
    }

    const temasResult = await DB.prepare(`
      SELECT st.*, t.* 
      FROM semana_temas st
      INNER JOIN temas t ON st.tema_id = t.id
      WHERE st.semana_id = ?
      ORDER BY st.ordem
    `).bind(semana.id).all()

    return c.json({
      semana,
      temas: temasResult.results
    })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// ====================================================
// API: REGISTRAR ESTUDO
// ====================================================
app.post('/api/estudo/registrar', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const usuarioId = auth.usuario.usuario_id
  
  try {
    const body = await c.req.json()
    const { tema_id, semana_tema_id, metodo, questoes_feitas, questoes_acertos, tempo_minutos, observacoes } = body

    if (!tema_id || !metodo) {
      return c.json({ error: 'tema_id e metodo são obrigatórios' }, 400)
    }

    const acuracia = questoes_feitas > 0 ? (questoes_acertos / questoes_feitas) * 100 : 0
    const hoje = new Date().toISOString().split('T')[0]

    // Inserir estudo
    const estudoResult = await DB.prepare(`
      INSERT INTO estudos (tema_id, semana_tema_id, data_estudo, metodo, questoes_feitas, questoes_acertos, acuracia, tempo_minutos, observacoes, usuario_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(tema_id, semana_tema_id || null, hoje, metodo, questoes_feitas || 0, questoes_acertos || 0, acuracia, tempo_minutos || 0, observacoes || null, usuarioId).run()

    const estudoId = estudoResult.meta.last_row_id

    // Buscar prevalência do tema
    const tema = await DB.prepare('SELECT prevalencia_numero FROM temas WHERE id = ?').bind(tema_id).first() as Tema

    // Calcular intervalos de revisão
    const intervalos = calcularIntervalos(tema.prevalencia_numero, acuracia)

    // Criar revisões
    for (let i = 0; i < intervalos.length; i++) {
      const dataAgendada = new Date()
      dataAgendada.setDate(dataAgendada.getDate() + intervalos[i])
      
      await DB.prepare(`
        INSERT INTO revisoes (estudo_id, tema_id, numero_revisao, data_agendada, intervalo_dias)
        VALUES (?, ?, ?, ?, ?)
      `).bind(estudoId, tema_id, i + 1, dataAgendada.toISOString().split('T')[0], intervalos[i]).run()
    }

    return c.json({ 
      success: true, 
      estudo_id: estudoId,
      acuracia,
      revisoes_agendadas: intervalos.length
    })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// ====================================================
// FUNÇÃO: CALCULAR INTERVALOS DE REVISÃO
// ====================================================
function calcularIntervalos(prevalencia: number, acuracia: number): number[] {
  // Intervalos base: 1d → 3d → 7d → 15d → 30d → 60d
  let intervalos = [1, 3, 7, 15, 30, 60]

  // Ajuste por prevalência (ALTA = 5, reduz intervalos)
  if (prevalencia === 5) {
    intervalos = intervalos.map(i => Math.floor(i * 0.7)) // 30% mais rápido
  } else if (prevalencia === 1) {
    intervalos = intervalos.map(i => Math.floor(i * 1.3)) // 30% mais lento
  }

  // Ajuste por acurácia (<70% = difícil, reduz intervalos)
  if (acuracia < 70) {
    intervalos = intervalos.map(i => Math.max(1, Math.floor(i * 0.6))) // 40% mais rápido
  } else if (acuracia > 85) {
    intervalos = intervalos.map(i => Math.floor(i * 1.4)) // 40% mais lento
  }

  return intervalos
}

// ====================================================
// API: REVISÕES PENDENTES
// ====================================================
app.get('/api/revisoes/pendentes', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const usuarioId = auth.usuario.usuario_id
  
  try {
    const hoje = new Date().toISOString().split('T')[0]

    const revisoesResult = await DB.prepare(`
      SELECT r.*, t.tema, t.area, t.prevalencia
      FROM revisoes r
      INNER JOIN temas t ON r.tema_id = t.id
      INNER JOIN estudos e ON r.estudo_id = e.id
      WHERE r.concluida = 0 AND r.data_agendada <= ? AND e.usuario_id = ?
      ORDER BY r.data_agendada ASC, t.prevalencia_numero DESC
      LIMIT 20
    `).bind(hoje, usuarioId).all()

    return c.json({ 
      revisoes: revisoesResult.results,
      total: revisoesResult.results.length
    })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// ====================================================
// API: MARCAR REVISÃO COMO CONCLUÍDA
// ====================================================
app.post('/api/revisao/concluir/:id', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const id = c.req.param('id')
  
  try {
    const body = await c.req.json()
    const { acuracia_revisao } = body

    const hoje = new Date().toISOString().split('T')[0]

    await DB.prepare(`
      UPDATE revisoes 
      SET concluida = 1, data_realizada = ?, acuracia_revisao = ?
      WHERE id = ?
    `).bind(hoje, acuracia_revisao || null, id).run()

    return c.json({ success: true })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// ====================================================
// API: MÉTRICAS GERAIS
// ====================================================
app.get('/api/metricas', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const usuarioId = auth.usuario.usuario_id
  
  try {
    // Total de estudos
    const totalEstudos = await DB.prepare('SELECT COUNT(*) as total FROM estudos WHERE usuario_id = ?').bind(usuarioId).first()

    // Total de questões feitas
    const totalQuestoes = await DB.prepare('SELECT SUM(questoes_feitas) as total FROM estudos WHERE usuario_id = ?').bind(usuarioId).first()

    // Acurácia média geral
    const acuraciaMedia = await DB.prepare('SELECT AVG(acuracia) as media FROM estudos WHERE acuracia > 0 AND usuario_id = ?').bind(usuarioId).first()

    // Acurácia por área
    const acuraciaPorArea = await DB.prepare(`
      SELECT t.area, AVG(e.acuracia) as media_acuracia, COUNT(e.id) as total_estudos
      FROM estudos e
      INNER JOIN temas t ON e.tema_id = t.id
      WHERE e.acuracia > 0 AND e.usuario_id = ?
      GROUP BY t.area
      ORDER BY media_acuracia ASC
    `).bind(usuarioId).all()

    // Temas mais errados
    const temasMaisErrados = await DB.prepare(`
      SELECT t.tema, t.area, AVG(e.acuracia) as media_acuracia
      FROM estudos e
      INNER JOIN temas t ON e.tema_id = t.id
      WHERE e.acuracia > 0
      GROUP BY e.tema_id
      HAVING AVG(e.acuracia) < 70
      ORDER BY media_acuracia ASC
      LIMIT 10
    `).all()

    // Revisões pendentes
    const hoje = new Date().toISOString().split('T')[0]
    const revisoesPendentes = await DB.prepare(`
      SELECT COUNT(*) as total FROM revisoes WHERE concluida = 0 AND data_agendada <= ?
    `).bind(hoje).first()

    return c.json({
      total_estudos: totalEstudos?.total || 0,
      total_questoes: totalQuestoes?.total || 0,
      acuracia_media: acuraciaMedia?.media || 0,
      acuracia_por_area: acuraciaPorArea.results,
      temas_mais_errados: temasMaisErrados.results,
      revisoes_pendentes: revisoesPendentes?.total || 0
    })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// ====================================================
// API: CONFIGURAÇÕES
// ====================================================
app.get('/api/config', async (c) => {
  const { DB } = c.env
  
  try {
    const config = await DB.prepare('SELECT * FROM configuracoes WHERE id = 1').first()
    return c.json(config)
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

app.post('/api/config', async (c) => {
  const { DB } = c.env
  
  try {
    const body = await c.req.json()
    const { horas_por_dia, temas_por_dia, data_prova, semana_atual } = body

    await DB.prepare(`
      UPDATE configuracoes 
      SET horas_por_dia = ?, temas_por_dia = ?, data_prova = ?, semana_atual = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).bind(horas_por_dia, temas_por_dia, data_prova, semana_atual).run()

    return c.json({ success: true })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// ====================================================
// FRONTEND: PÁGINA PRINCIPAL (PROTEGIDA)
// ====================================================
app.get('/', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) {
    return c.redirect('/login')
  }

  const nomeUsuario = auth.usuario.nome || 'Usuário'

  return c.html(`
    <!DOCTYPE html>
    <html lang="pt-BR" id="html-root">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>🧠 Cérebro de Estudos HardMed</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
        <style>
            /* Dark theme variables */
            .dark {
                --bg-primary: #1a1a2e;
                --bg-secondary: #16213e;
                --bg-card: #0f3460;
                --text-primary: #e8e8e8;
                --text-secondary: #a0a0a0;
            }
            .dark body {
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%) !important;
            }
            .dark .bg-white {
                background-color: var(--bg-card) !important;
            }
            .dark .text-gray-800 {
                color: var(--text-primary) !important;
            }
            .dark .text-gray-600 {
                color: var(--text-secondary) !important;
            }
            .dark .border-gray-200 {
                border-color: #2d3748 !important;
            }
        </style>
    </head>
    <body class="bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen">
        <!-- Header -->
        <header class="bg-white shadow-lg border-b-4 border-indigo-600">
            <div class="max-w-7xl mx-auto px-4 py-6">
                <div class="flex items-center justify-between">
                    <div class="flex items-center space-x-4">
                        <div class="bg-indigo-600 p-3 rounded-xl">
                            <i class="fas fa-brain text-white text-3xl"></i>
                        </div>
                        <div>
                            <h1 class="text-3xl font-bold text-gray-800">Cérebro de Estudos HardMed</h1>
                            <p class="text-gray-600">Sistema Inteligente de Revisões ENARE</p>
                        </div>
                    </div>
                    <div class="flex items-center space-x-6">
                        <div class="text-right">
                            <p class="text-sm text-gray-600">Semana Atual</p>
                            <p class="text-2xl font-bold text-indigo-600" id="semana-atual">--</p>
                        </div>
                        <div class="flex items-center space-x-3">
                            <button onclick="toggleTheme()" class="bg-gray-100 hover:bg-gray-200 px-4 py-2 rounded-lg transition" title="Alternar tema">
                                <i id="theme-icon" class="fas fa-moon text-gray-700"></i>
                            </button>
                            <div class="text-right">
                                <p class="text-sm text-gray-600">Olá, ${nomeUsuario}!</p>
                                <button onclick="logout()" class="text-sm text-red-600 hover:text-red-700 font-semibold">
                                    <i class="fas fa-sign-out-alt mr-1"></i>Sair
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </header>

        <!-- Main Content -->
        <div class="max-w-7xl mx-auto px-4 py-8">
            <!-- Tabs -->
            <div class="flex space-x-2 mb-6">
                <button onclick="showTab('dashboard')" class="tab-btn active px-6 py-3 bg-white rounded-lg shadow font-semibold">
                    <i class="fas fa-home mr-2"></i>Dashboard
                </button>
                <button onclick="showTab('ciclo')" class="tab-btn px-6 py-3 bg-white rounded-lg shadow font-semibold">
                    <i class="fas fa-calendar-alt mr-2"></i>Ciclo 40 Semanas
                </button>
                <button onclick="showTab('revisoes')" class="tab-btn px-6 py-3 bg-white rounded-lg shadow font-semibold">
                    <i class="fas fa-sync-alt mr-2"></i>Revisões
                </button>
                <button onclick="showTab('metricas')" class="tab-btn px-6 py-3 bg-white rounded-lg shadow font-semibold">
                    <i class="fas fa-chart-bar mr-2"></i>Métricas
                </button>
            </div>

            <!-- Tab: Dashboard -->
            <div id="tab-dashboard" class="tab-content">
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                    <!-- Guia do Dia -->
                    <div class="bg-white rounded-xl shadow-lg p-6">
                        <h2 class="text-2xl font-bold text-gray-800 mb-4 flex items-center">
                            <i class="fas fa-calendar-day text-indigo-600 mr-3"></i>
                            Guia do Dia
                        </h2>
                        <div id="guia-do-dia" class="space-y-4">
                            <p class="text-gray-600">Carregando...</p>
                        </div>
                    </div>

                    <!-- Revisões do Dia -->
                    <div class="bg-white rounded-xl shadow-lg p-6">
                        <h2 class="text-2xl font-bold text-gray-800 mb-4 flex items-center">
                            <i class="fas fa-sync-alt text-orange-600 mr-3"></i>
                            Revisões Pendentes
                        </h2>
                        <div id="revisoes-do-dia" class="space-y-4">
                            <p class="text-gray-600">Carregando...</p>
                        </div>
                    </div>
                </div>

                <!-- Quick Stats -->
                <div class="grid grid-cols-1 md:grid-cols-4 gap-4" id="quick-stats">
                    <div class="bg-white rounded-xl shadow-lg p-6">
                        <div class="flex items-center justify-between">
                            <div>
                                <p class="text-gray-600 text-sm">Total Estudos</p>
                                <p class="text-3xl font-bold text-indigo-600">--</p>
                            </div>
                            <i class="fas fa-book text-4xl text-indigo-200"></i>
                        </div>
                    </div>
                    <div class="bg-white rounded-xl shadow-lg p-6">
                        <div class="flex items-center justify-between">
                            <div>
                                <p class="text-gray-600 text-sm">Questões Feitas</p>
                                <p class="text-3xl font-bold text-green-600">--</p>
                            </div>
                            <i class="fas fa-question-circle text-4xl text-green-200"></i>
                        </div>
                    </div>
                    <div class="bg-white rounded-xl shadow-lg p-6">
                        <div class="flex items-center justify-between">
                            <div>
                                <p class="text-gray-600 text-sm">Acurácia Média</p>
                                <p class="text-3xl font-bold text-blue-600">--</p>
                            </div>
                            <i class="fas fa-percent text-4xl text-blue-200"></i>
                        </div>
                    </div>
                    <div class="bg-white rounded-xl shadow-lg p-6">
                        <div class="flex items-center justify-between">
                            <div>
                                <p class="text-gray-600 text-sm">Revisões Hoje</p>
                                <p class="text-3xl font-bold text-orange-600">--</p>
                            </div>
                            <i class="fas fa-redo text-4xl text-orange-200"></i>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Tab: Ciclo -->
            <div id="tab-ciclo" class="tab-content hidden">
                <div class="bg-white rounded-xl shadow-lg p-6 mb-6">
                    <h2 class="text-2xl font-bold text-gray-800 mb-4">Gerador de Ciclo de 40 Semanas</h2>
                    <p class="text-gray-600 mb-4">Distribui automaticamente 419 temas em 40 semanas, priorizando prevalência e balanceando áreas.</p>
                    <button onclick="gerarCiclo()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-lg font-semibold">
                        <i class="fas fa-cogs mr-2"></i>Gerar Ciclo Agora
                    </button>
                </div>

                <div class="bg-white rounded-xl shadow-lg p-6">
                    <h2 class="text-2xl font-bold text-gray-800 mb-4">Mapa de 40 Semanas</h2>
                    <div id="mapa-semanas" class="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <p class="text-gray-600 col-span-4">Carregando...</p>
                    </div>
                </div>
            </div>

            <!-- Tab: Revisões -->
            <div id="tab-revisoes" class="tab-content hidden">
                <div class="bg-white rounded-xl shadow-lg p-6">
                    <h2 class="text-2xl font-bold text-gray-800 mb-4">Sistema de Revisões Inteligentes</h2>
                    <div id="lista-revisoes" class="space-y-4">
                        <p class="text-gray-600">Carregando...</p>
                    </div>
                </div>
            </div>

            <!-- Tab: Métricas -->
            <div id="tab-metricas" class="tab-content hidden">
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div class="bg-white rounded-xl shadow-lg p-6">
                        <h2 class="text-2xl font-bold text-gray-800 mb-4">Acurácia por Área</h2>
                        <canvas id="chartAcuracia"></canvas>
                    </div>
                    <div class="bg-white rounded-xl shadow-lg p-6">
                        <h2 class="text-2xl font-bold text-gray-800 mb-4">Temas Mais Errados</h2>
                        <div id="temas-errados" class="space-y-2">
                            <p class="text-gray-600">Carregando...</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <script>
        // ====================================================
        // SISTEMA DE MODAIS CUSTOMIZADOS
        // ====================================================
        class Modal {
          static show(options) {
            const { title, content, buttons = [], type = 'info' } = options;
            
            const overlay = document.createElement('div');
            overlay.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
            overlay.style.animation = 'fadeIn 0.2s ease-out';
            
            const icons = {
              info: '<i class="fas fa-info-circle text-blue-500 text-4xl"></i>',
              success: '<i class="fas fa-check-circle text-green-500 text-4xl"></i>',
              warning: '<i class="fas fa-exclamation-triangle text-yellow-500 text-4xl"></i>',
              error: '<i class="fas fa-times-circle text-red-500 text-4xl"></i>',
              question: '<i class="fas fa-question-circle text-indigo-500 text-4xl"></i>'
            };
            
            overlay.innerHTML = \`
              <div class="bg-white rounded-xl shadow-2xl max-w-md w-full mx-4 transform scale-95" style="animation: scaleIn 0.2s ease-out forwards">
                <div class="p-6">
                  <div class="flex items-start space-x-4">
                    <div class="flex-shrink-0">
                      \${icons[type] || icons.info}
                    </div>
                    <div class="flex-1">
                      <h3 class="text-xl font-bold text-gray-900 mb-2">\${title}</h3>
                      <div class="text-gray-600">\${content}</div>
                    </div>
                  </div>
                  <div class="flex justify-end space-x-3 mt-6">
                    \${buttons.map((btn, i) => \`
                      <button 
                        data-btn-index="\${i}"
                        class="\${btn.primary ? 'bg-indigo-600 hover:bg-indigo-700 text-white' : 'bg-gray-200 hover:bg-gray-300 text-gray-800'} px-5 py-2 rounded-lg font-semibold transition"
                      >
                        \${btn.label}
                      </button>
                    \`).join('')}
                  </div>
                </div>
              </div>
            \`;
            
            document.body.appendChild(overlay);
            
            // Event listeners
            overlay.querySelectorAll('button').forEach((btn, i) => {
              btn.addEventListener('click', () => {
                if (buttons[i].callback) buttons[i].callback();
                document.body.removeChild(overlay);
              });
            });
            
            // Close on overlay click
            overlay.addEventListener('click', (e) => {
              if (e.target === overlay) {
                document.body.removeChild(overlay);
              }
            });
          }
          
          static alert(title, message, type = 'info') {
            return new Promise((resolve) => {
              Modal.show({
                title,
                content: message,
                type,
                buttons: [
                  { label: 'OK', primary: true, callback: resolve }
                ]
              });
            });
          }
          
          static confirm(title, message, onConfirm, onCancel) {
            Modal.show({
              title,
              content: message,
              type: 'question',
              buttons: [
                { label: 'Cancelar', primary: false, callback: onCancel || (() => {}) },
                { label: 'Confirmar', primary: true, callback: onConfirm || (() => {}) }
              ]
            });
          }
          
          static input(title, placeholder, onSubmit, defaultValue = '') {
            const inputId = 'modal-input-' + Date.now();
            
            Modal.show({
              title,
              content: \`
                <input 
                  id="\${inputId}" 
                  type="text" 
                  placeholder="\${placeholder}"
                  value="\${defaultValue}"
                  class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 mt-2"
                />
              \`,
              type: 'question',
              buttons: [
                { label: 'Cancelar', primary: false, callback: () => {} },
                { 
                  label: 'Confirmar', 
                  primary: true, 
                  callback: () => {
                    const input = document.getElementById(inputId);
                    if (input && input.value.trim() && onSubmit) {
                      onSubmit(input.value.trim());
                    }
                  }
                }
              ]
            });
            
            // Focus input after modal renders
            setTimeout(() => {
              const input = document.getElementById(inputId);
              if (input) input.focus();
            }, 100);
          }
        }
        
        // Adicionar animações CSS
        const modalStyles = document.createElement('style');
        modalStyles.textContent = \`
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          @keyframes scaleIn {
            from { transform: scale(0.95); opacity: 0; }
            to { transform: scale(1); opacity: 1; }
          }
        \`;
        document.head.appendChild(modalStyles);
        
        // ====================================================
        // FRONTEND JAVASCRIPT
        // ====================================================
        
        let chartAcuracia = null;

        // Theme Manager
        function toggleTheme() {
            const html = document.getElementById('html-root')
            const icon = document.getElementById('theme-icon')
            
            if (html.classList.contains('dark')) {
                html.classList.remove('dark')
                icon.className = 'fas fa-moon text-gray-700'
                localStorage.setItem('theme', 'light')
            } else {
                html.classList.add('dark')
                icon.className = 'fas fa-sun text-yellow-400'
                localStorage.setItem('theme', 'dark')
            }
        }

        // Carregar tema salvo
        const savedTheme = localStorage.getItem('theme')
        if (savedTheme === 'dark') {
            document.getElementById('html-root').classList.add('dark')
            document.getElementById('theme-icon').className = 'fas fa-sun text-yellow-400'
        }

        // Logout
        async function logout() {
            try {
                await fetch('/api/auth/logout', { method: 'POST' })
                document.cookie = 'auth_token=; path=/; max-age=0'
                window.location.href = '/login'
            } catch (error) {
                console.error('Erro ao fazer logout:', error)
            }
        }

        // Carregar dados iniciais
        document.addEventListener('DOMContentLoaded', () => {
            loadDashboard()
            loadMetricas()
            loadSemanas()
        })

        // Tabs
        function showTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'))
            document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active', 'bg-indigo-600', 'text-white'))
            
            document.getElementById('tab-' + tabName).classList.remove('hidden')
            event.target.closest('.tab-btn').classList.add('active', 'bg-indigo-600', 'text-white')

            if (tabName === 'revisoes') loadRevisoes()
            if (tabName === 'metricas') loadMetricas()
        }

        // Dashboard
        async function loadDashboard() {
          try {
            const semanaRes = await fetch('/api/semana/atual')
            const semanaData = await semanaRes.json()
            
            document.getElementById('semana-atual').textContent = semanaData.semana?.numero_semana || '--'

            const guiaDiv = document.getElementById('guia-do-dia')
            if (semanaData.temas && semanaData.temas.length > 0) {
              guiaDiv.innerHTML = semanaData.temas.map(t => \`
                <div class="border border-gray-200 rounded-lg p-4 hover:border-indigo-400 transition">
                  <div class="flex items-start justify-between">
                    <div class="flex-1">
                      <h3 class="font-bold text-gray-800">\${t.tema}</h3>
                      <p class="text-sm text-gray-600">\${t.area} · \${t.prevalencia}</p>
                      <p class="text-sm text-gray-500 mt-1">\${t.subtopicos || ''}</p>
                      <p class="text-xs text-indigo-600 mt-2"><i class="fas fa-clock mr-1"></i>Meta: \${t.meta_tempo_minutos} min · \${t.meta_questoes} questões</p>
                    </div>
                    <button onclick="registrarEstudo(\${t.tema_id}, \${t.id})" class="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded-lg text-sm">
                      <i class="fas fa-check mr-1"></i>Concluir
                    </button>
                  </div>
                </div>
              \`).join('')
            } else {
              guiaDiv.innerHTML = '<p class="text-gray-600">Nenhum tema para hoje</p>'
            }

            const revisoesRes = await fetch('/api/revisoes/pendentes')
            const revisoesData = await revisoesRes.json()
            
            const revisoesDiv = document.getElementById('revisoes-do-dia')
            if (revisoesData.revisoes && revisoesData.revisoes.length > 0) {
              revisoesDiv.innerHTML = revisoesData.revisoes.slice(0, 5).map(r => \`
                <div class="border border-orange-200 rounded-lg p-3 bg-orange-50">
                  <h4 class="font-semibold text-gray-800">\${r.tema}</h4>
                  <p class="text-sm text-gray-600">\${r.area} · Revisão #\${r.numero_revisao}</p>
                  <button onclick="concluirRevisao(\${r.id})" class="mt-2 bg-orange-500 hover:bg-orange-600 text-white px-3 py-1 rounded text-sm">
                    <i class="fas fa-check mr-1"></i>Marcar Revisada
                  </button>
                </div>
              \`).join('')
            } else {
              revisoesDiv.innerHTML = '<p class="text-gray-600">Nenhuma revisão pendente hoje 🎉</p>'
            }

            // Quick stats
            const metricasRes = await fetch('/api/metricas')
            const metricasData = await metricasRes.json()
            
            const stats = document.querySelectorAll('#quick-stats .text-3xl')
            stats[0].textContent = metricasData.total_estudos || 0
            stats[1].textContent = metricasData.total_questoes || 0
            stats[2].textContent = metricasData.acuracia_media ? metricasData.acuracia_media.toFixed(1) + '%' : '--'
            stats[3].textContent = metricasData.revisoes_pendentes || 0

          } catch (error) {
            console.error('Erro ao carregar dashboard:', error)
          }
        }

        // Registrar estudo
        async function registrarEstudo(temaId, semanaTemaId) {
          Modal.input('Quantas questões você fez?', 'Ex: 15', async (questoes) => {
            if (!questoes) return;
            
            Modal.input('Quantas você acertou?', 'Ex: 12', async (acertos) => {
              if (!acertos) return;
              
              Modal.input('Tempo em minutos?', 'Ex: 60', async (tempo) => {
                if (!tempo) return;
                
                try {
                  const res = await fetch('/api/estudo/registrar', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      tema_id: temaId,
                      semana_tema_id: semanaTemaId,
                      metodo: 'questoes',
                      questoes_feitas: parseInt(questoes),
                      questoes_acertos: parseInt(acertos),
                      tempo_minutos: parseInt(tempo)
                    })
                  })

                  const data = await res.json()
                  if (data.success) {
                    await Modal.alert('Sucesso!', 'Estudo registrado! Acurácia: ' + data.acuracia.toFixed(1) + '%', 'success')
                    loadDashboard()
                  } else {
                    await Modal.alert('Erro', data.error, 'error')
                  }
                } catch (error) {
                  await Modal.alert('Erro', 'Erro ao registrar estudo', 'error')
                }
              }, '60')
            }, '12')
          }, '15')
        }

        // Concluir revisão
        async function concluirRevisao(revisaoId) {
          Modal.input('Qual foi sua acurácia na revisão?', 'Digite 0-100', async (acuracia) => {
            if (!acuracia) return;

            try {
              const res = await fetch(\`/api/revisao/concluir/\${revisaoId}\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ acuracia_revisao: parseFloat(acuracia) })
              })

              const data = await res.json()
              if (data.success) {
                await Modal.alert('Sucesso!', 'Revisão concluída!', 'success')
                loadDashboard()
              } else {
                await Modal.alert('Erro', data.error, 'error')
              }
            } catch (error) {
              await Modal.alert('Erro', 'Erro ao concluir revisão', 'error')
            }
          }, '80')
        }

        // Gerar ciclo
        async function gerarCiclo() {
          Modal.confirm(
            'Gerar Ciclo de 40 Semanas', 
            'Esta operação distribuirá 419 temas em 40 semanas. Só pode ser feita uma vez!',
            async () => {
              try {
                const res = await fetch('/api/ciclo/gerar', { method: 'POST' })
                const data = await res.json()
                
                if (data.success) {
                  await Modal.alert('Sucesso!', 'Ciclo gerado com sucesso! ' + data.semanas + ' semanas criadas.', 'success')
                  loadSemanas()
                } else {
                  await Modal.alert('Erro', data.error, 'error')
                }
              } catch (error) {
                await Modal.alert('Erro', 'Erro ao gerar ciclo', 'error')
              }
            }
          )
        }

        // Carregar semanas
        async function loadSemanas() {
          try {
            const res = await fetch('/api/semanas')
            const data = await res.json()
            
            const mapaDiv = document.getElementById('mapa-semanas')
            if (data.semanas && data.semanas.length > 0) {
              mapaDiv.innerHTML = data.semanas.map(s => \`
                <div 
                  class="border rounded-lg p-4 cursor-pointer hover:shadow-lg transition \${s.concluida ? 'bg-green-50 border-green-300' : 'bg-white border-gray-200 hover:border-indigo-400'}"
                  onclick="verTemasDaSemana(\${s.numero_semana})"
                >
                  <h3 class="font-bold text-gray-800">Semana \${s.numero_semana}</h3>
                  <p class="text-sm text-gray-600">\${s.total_temas || 0} temas</p>
                  <p class="text-xs text-gray-500 mt-2">\${s.temas_concluidos || 0}/\${s.total_temas || 0} concluídos</p>
                  <p class="text-xs text-indigo-600 mt-2"><i class="fas fa-eye mr-1"></i>Clique para ver temas</p>
                </div>
              \`).join('')
            } else {
              mapaDiv.innerHTML = '<p class="text-gray-600 col-span-4">Nenhuma semana gerada. Clique em "Gerar Ciclo Agora".</p>'
            }
          } catch (error) {
            console.error('Erro ao carregar semanas:', error)
          }
        }
        
        // Ver temas de uma semana específica
        async function verTemasDaSemana(numeroSemana) {
          try {
            const res = await fetch(\`/api/semana/\${numeroSemana}\`)
            const data = await res.json()
            
            if (data.temas && data.temas.length > 0) {
              const temasHTML = data.temas.map(t => \`
                <div class="border border-gray-200 rounded-lg p-3 hover:bg-gray-50">
                  <h4 class="font-semibold text-gray-800">\${t.tema}</h4>
                  <p class="text-sm text-gray-600">\${t.area} · \${t.prevalencia}</p>
                  <p class="text-xs text-gray-500 mt-1">\${t.subtopicos || ''}</p>
                  <div class="flex items-center justify-between mt-2">
                    <span class="text-xs text-indigo-600"><i class="fas fa-clock mr-1"></i>\${t.meta_tempo_minutos} min · \${t.meta_questoes} questões</span>
                    <span class="text-xs font-semibold \${t.metodo === 'questoes' ? 'text-green-600' : 'text-blue-600'}">
                      <i class="fas \${t.metodo === 'questoes' ? 'fa-question-circle' : 'fa-book'} mr-1"></i>
                      \${t.metodo === 'questoes' ? 'Questões' : 'Teoria'}
                    </span>
                  </div>
                </div>
              \`).join('')
              
              Modal.show({
                title: \`Semana \${numeroSemana} - Temas para Estudar\`,
                content: \`
                  <div class="max-h-96 overflow-y-auto space-y-3">
                    \${temasHTML}
                  </div>
                  <p class="text-sm text-gray-600 mt-4">Total: \${data.temas.length} temas</p>
                \`,
                type: 'info',
                buttons: [
                  { label: 'Fechar', primary: true, callback: () => {} }
                ]
              })
            } else {
              await Modal.alert('Sem Temas', 'Esta semana não possui temas cadastrados.', 'info')
            }
          } catch (error) {
            console.error('Erro ao carregar temas da semana:', error)
            await Modal.alert('Erro', 'Erro ao carregar temas da semana', 'error')
          }
        }

        // Carregar revisões
        async function loadRevisoes() {
          try {
            const res = await fetch('/api/revisoes/pendentes')
            const data = await res.json()
            
            const listaDiv = document.getElementById('lista-revisoes')
            if (data.revisoes && data.revisoes.length > 0) {
              listaDiv.innerHTML = data.revisoes.map(r => \`
                <div class="border border-gray-200 rounded-lg p-4">
                  <div class="flex items-start justify-between">
                    <div class="flex-1">
                      <h3 class="font-bold text-gray-800">\${r.tema}</h3>
                      <p class="text-sm text-gray-600">\${r.area} · \${r.prevalencia} · Revisão #\${r.numero_revisao}</p>
                      <p class="text-xs text-gray-500 mt-1">Agendada: \${r.data_agendada}</p>
                    </div>
                    <button onclick="concluirRevisao(\${r.id})" class="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-lg text-sm">
                      <i class="fas fa-check mr-1"></i>Concluir
                    </button>
                  </div>
                </div>
              \`).join('')
            } else {
              listaDiv.innerHTML = '<p class="text-gray-600">Nenhuma revisão pendente 🎉</p>'
            }
          } catch (error) {
            console.error('Erro ao carregar revisões:', error)
          }
        }

        // Carregar métricas
        async function loadMetricas() {
          try {
            const res = await fetch('/api/metricas')
            const data = await res.json()

            // Gráfico de acurácia por área
            const ctx = document.getElementById('chartAcuracia')
            if (chartAcuracia) chartAcuracia.destroy()

            if (data.acuracia_por_area && data.acuracia_por_area.length > 0) {
              chartAcuracia = new Chart(ctx, {
                type: 'bar',
                data: {
                  labels: data.acuracia_por_area.map(a => a.area),
                  datasets: [{
                    label: 'Acurácia Média (%)',
                    data: data.acuracia_por_area.map(a => a.media_acuracia),
                    backgroundColor: 'rgba(99, 102, 241, 0.5)',
                    borderColor: 'rgba(99, 102, 241, 1)',
                    borderWidth: 2
                  }]
                },
                options: {
                  responsive: true,
                  scales: {
                    y: { beginAtZero: true, max: 100 }
                  }
                }
              })
            }

            // Temas mais errados
            const temasDiv = document.getElementById('temas-errados')
            if (data.temas_mais_errados && data.temas_mais_errados.length > 0) {
              temasDiv.innerHTML = data.temas_mais_errados.map(t => \`
                <div class="border border-red-200 rounded-lg p-3 bg-red-50">
                  <h4 class="font-semibold text-gray-800">\${t.tema}</h4>
                  <p class="text-sm text-gray-600">\${t.area} · <span class="text-red-600 font-bold">\${t.media_acuracia.toFixed(1)}%</span></p>
                </div>
              \`).join('')
            } else {
              temasDiv.innerHTML = '<p class="text-gray-600">Nenhum tema com <70% de acurácia 🎉</p>'
            }

          } catch (error) {
            console.error('Erro ao carregar métricas:', error)
          }
        }

        // Estilo CSS adicional
        const style = document.createElement('style')
        style.textContent = \`
          .tab-btn.active {
            background-color: #4f46e5;
            color: white;
          }
          .tab-btn:hover {
            background-color: #e0e7ff;
          }
          .tab-btn.active:hover {
            background-color: #4338ca;
          }
        \`
        document.head.appendChild(style)
        </script>
    </body>
    </html>
  `)
})

// ====================================================
// AUTENTICAÇÃO: APIs
// ====================================================

// Helper: gerar token aleatório
function gerarToken(): string {
  return Array.from({ length: 32 }, () => 
    Math.random().toString(36).charAt(2)
  ).join('')
}

// Helper: hash simples (use bcrypt em produção!)
async function hashSenha(senha: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(senha + 'salt_hardmed_2026')
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

// Middleware: verificar autenticação
async function requireAuth(c: any) {
  const { DB } = c.env
  const token = getCookie(c, 'auth_token')
  
  if (!token) {
    return { error: 'Não autenticado', status: 401 }
  }

  const hoje = new Date().toISOString()
  const sessao = await DB.prepare(`
    SELECT s.*, u.id as usuario_id, u.email, u.nome, u.data_prova
    FROM sessoes s
    INNER JOIN usuarios u ON s.usuario_id = u.id
    WHERE s.token = ? AND s.expires_at > ?
  `).bind(token, hoje).first()

  if (!sessao) {
    return { error: 'Sessão expirada', status: 401 }
  }

  return { usuario: sessao }
}

// API: Registro
app.post('/api/auth/registro', async (c) => {
  const { DB } = c.env
  
  try {
    const { email, senha, nome, data_prova } = await c.req.json()

    if (!email || !senha || !nome) {
      return c.json({ error: 'Email, senha e nome são obrigatórios' }, 400)
    }

    // Verificar se email já existe
    const usuarioExiste = await DB.prepare('SELECT id FROM usuarios WHERE email = ?')
      .bind(email).first()

    if (usuarioExiste) {
      return c.json({ error: 'Email já cadastrado' }, 400)
    }

    // Hash da senha
    const senhaHash = await hashSenha(senha)

    // Inserir usuário
    const result = await DB.prepare(`
      INSERT INTO usuarios (email, senha_hash, nome, data_prova)
      VALUES (?, ?, ?, ?)
    `).bind(email, senhaHash, nome, data_prova || null).run()

    const usuarioId = result.meta.last_row_id

    // Criar configuração inicial
    await DB.prepare(`
      INSERT INTO configuracoes (usuario_id, horas_por_dia, temas_por_dia, data_prova, semana_atual, ciclo_gerado)
      VALUES (?, 4, 4, ?, 1, 0)
    `).bind(usuarioId, data_prova || null).run()

    // Criar sessão
    const token = gerarToken()
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + 30) // 30 dias

    await DB.prepare(`
      INSERT INTO sessoes (usuario_id, token, expires_at)
      VALUES (?, ?, ?)
    `).bind(usuarioId, token, expiresAt.toISOString()).run()

    setCookie(c, 'auth_token', token, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 2592000 // 30 dias
    })

    return c.json({ 
      success: true, 
      token,
      usuario: { id: usuarioId, email, nome }
    })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// API: Login
app.post('/api/auth/login', async (c) => {
  const { DB } = c.env
  
  try {
    const { email, senha } = await c.req.json()

    if (!email || !senha) {
      return c.json({ error: 'Email e senha são obrigatórios' }, 400)
    }

    // Buscar usuário
    const senhaHash = await hashSenha(senha)
    const usuario = await DB.prepare(`
      SELECT * FROM usuarios WHERE email = ? AND senha_hash = ?
    `).bind(email, senhaHash).first()

    if (!usuario) {
      return c.json({ error: 'Email ou senha incorretos' }, 401)
    }

    // Atualizar last_login
    await DB.prepare('UPDATE usuarios SET last_login = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(usuario.id).run()

    // Criar sessão
    const token = gerarToken()
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + 30) // 30 dias

    await DB.prepare(`
      INSERT INTO sessoes (usuario_id, token, expires_at)
      VALUES (?, ?, ?)
    `).bind(usuario.id, token, expiresAt.toISOString()).run()

    setCookie(c, 'auth_token', token, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 2592000 // 30 dias
    })

    return c.json({ 
      success: true, 
      token,
      usuario: { id: usuario.id, email: usuario.email, nome: usuario.nome }
    })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// API: Logout
app.post('/api/auth/logout', async (c) => {
  const { DB } = c.env
  const token = getCookie(c, 'auth_token')
  
  if (token) {
    await DB.prepare('DELETE FROM sessoes WHERE token = ?').bind(token).run()
  }

  deleteCookie(c, 'auth_token')
  return c.json({ success: true })
})

// API: Verificar sessão
app.get('/api/auth/me', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)
  
  return c.json({ usuario: auth.usuario })
})

// ====================================================
// ROTA: LANDING PAGE
// ====================================================
app.get('/home', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Cérebro HardMed - Sistema de Estudos ENARE 2026</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <style>
            .gradient-bg { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
            .card-hover { transition: all 0.3s ease; }
            .card-hover:hover { transform: translateY(-8px); box-shadow: 0 20px 40px rgba(0,0,0,0.2); }
            @keyframes fadeInUp {
                from { opacity: 0; transform: translateY(30px); }
                to { opacity: 1; transform: translateY(0); }
            }
            .fade-in-up { animation: fadeInUp 0.6s ease-out; }
        </style>
    </head>
    <body class="bg-white">
        <!-- Hero Section -->
        <div class="gradient-bg min-h-screen flex items-center justify-center px-4">
            <div class="max-w-5xl mx-auto text-center text-white fade-in-up">
                <div class="mb-8">
                    <i class="fas fa-brain text-8xl mb-6 animate-pulse"></i>
                </div>
                <h1 class="text-6xl font-bold mb-4">Cérebro de Estudos HardMed</h1>
                <p class="text-2xl mb-8 opacity-90">Sistema Inteligente de Revisões para ENARE 2026</p>
                <p class="text-xl mb-12 max-w-2xl mx-auto opacity-80">
                    Domine os 419 temas do ENARE com algoritmo de repetição espaçada, 
                    ciclo de 40 semanas e métricas avançadas de performance
                </p>
                <div class="flex justify-center space-x-4">
                    <a href="/login" class="bg-white text-indigo-600 px-8 py-4 rounded-xl font-bold text-lg hover:bg-gray-100 transition shadow-xl">
                        <i class="fas fa-sign-in-alt mr-2"></i>Entrar na Plataforma
                    </a>
                    <a href="/login?registro=true" class="bg-indigo-800 text-white px-8 py-4 rounded-xl font-bold text-lg hover:bg-indigo-900 transition shadow-xl">
                        <i class="fas fa-user-plus mr-2"></i>Criar Conta Grátis
                    </a>
                </div>
            </div>
        </div>

        <!-- Features Section -->
        <div class="py-20 px-4 bg-gray-50">
            <div class="max-w-6xl mx-auto">
                <h2 class="text-4xl font-bold text-center text-gray-800 mb-16">Recursos Poderosos</h2>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
                    <!-- Feature 1 -->
                    <div class="bg-white rounded-xl shadow-lg p-8 card-hover">
                        <div class="text-indigo-600 text-5xl mb-4">
                            <i class="fas fa-calendar-alt"></i>
                        </div>
                        <h3 class="text-2xl font-bold text-gray-800 mb-3">Ciclo de 40 Semanas</h3>
                        <p class="text-gray-600">
                            Distribuição inteligente dos 419 temas do ENARE em 40 semanas, 
                            priorizando prevalência e balanceando áreas
                        </p>
                    </div>

                    <!-- Feature 2 -->
                    <div class="bg-white rounded-xl shadow-lg p-8 card-hover">
                        <div class="text-green-600 text-5xl mb-4">
                            <i class="fas fa-sync-alt"></i>
                        </div>
                        <h3 class="text-2xl font-bold text-gray-800 mb-3">Revisões Espaçadas</h3>
                        <p class="text-gray-600">
                            Algoritmo adaptativo que ajusta intervalos baseado em prevalência 
                            e sua performance individual
                        </p>
                    </div>

                    <!-- Feature 3 -->
                    <div class="bg-white rounded-xl shadow-lg p-8 card-hover">
                        <div class="text-orange-600 text-5xl mb-4">
                            <i class="fas fa-chart-line"></i>
                        </div>
                        <h3 class="text-2xl font-bold text-gray-800 mb-3">Métricas Avançadas</h3>
                        <p class="text-gray-600">
                            Acompanhe acurácia por área, identifique pontos fracos e 
                            visualize seu progresso em tempo real
                        </p>
                    </div>

                    <!-- Feature 4 -->
                    <div class="bg-white rounded-xl shadow-lg p-8 card-hover">
                        <div class="text-blue-600 text-5xl mb-4">
                            <i class="fas fa-brain"></i>
                        </div>
                        <h3 class="text-2xl font-bold text-gray-800 mb-3">419 Temas Completos</h3>
                        <p class="text-gray-600">
                            Todas as áreas do ENARE: Clínica Médica, Cirurgia, GO, Pediatria, 
                            Preventiva e Saúde da Família
                        </p>
                    </div>

                    <!-- Feature 5 -->
                    <div class="bg-white rounded-xl shadow-lg p-8 card-hover">
                        <div class="text-purple-600 text-5xl mb-4">
                            <i class="fas fa-target"></i>
                        </div>
                        <h3 class="text-2xl font-bold text-gray-800 mb-3">Metas Personalizadas</h3>
                        <p class="text-gray-600">
                            Configure horas e temas por dia de acordo com sua disponibilidade 
                            e estilo de estudo
                        </p>
                    </div>

                    <!-- Feature 6 -->
                    <div class="bg-white rounded-xl shadow-lg p-8 card-hover">
                        <div class="text-red-600 text-5xl mb-4">
                            <i class="fas fa-fire"></i>
                        </div>
                        <h3 class="text-2xl font-bold text-gray-800 mb-3">Foco Total</h3>
                        <p class="text-gray-600">
                            Guia do dia automatizado mostra exatamente o que estudar, 
                            sem perder tempo decidindo
                        </p>
                    </div>
                </div>
            </div>
        </div>

        <!-- CTA Section -->
        <div class="gradient-bg py-20 px-4">
            <div class="max-w-4xl mx-auto text-center text-white">
                <h2 class="text-4xl font-bold mb-6">Pronto para Dominar o ENARE 2026?</h2>
                <p class="text-xl mb-8 opacity-90">
                    Junte-se a centenas de estudantes que já estão usando o método mais eficiente
                </p>
                <a href="/login" class="bg-white text-indigo-600 px-12 py-5 rounded-xl font-bold text-xl hover:bg-gray-100 transition shadow-2xl inline-block">
                    <i class="fas fa-rocket mr-2"></i>Começar Agora - É Grátis!
                </a>
            </div>
        </div>

        <!-- Footer -->
        <footer class="bg-gray-900 text-white py-12 px-4">
            <div class="max-w-6xl mx-auto text-center">
                <div class="mb-6">
                    <i class="fas fa-brain text-5xl text-indigo-400 mb-4"></i>
                </div>
                <p class="text-gray-400 mb-4">© 2025 Cérebro HardMed. Sistema inteligente de estudos para ENARE.</p>
                <p class="text-gray-500 text-sm">
                    <i class="fas fa-code mr-2"></i>Desenvolvido com Hono + Cloudflare + IA
                </p>
            </div>
        </footer>
    </body>
    </html>
  `)
})

// ====================================================
// ROTA: LOGIN/REGISTRO
// ====================================================
app.get('/login', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Login - Cérebro HardMed</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <style>
            .gradient-bg { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
        </style>
    </head>
    <body class="gradient-bg min-h-screen flex items-center justify-center px-4">
        <div class="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8">
            <div class="text-center mb-8">
                <i class="fas fa-brain text-6xl text-indigo-600 mb-4"></i>
                <h1 class="text-3xl font-bold text-gray-800">Cérebro HardMed</h1>
                <p class="text-gray-600 mt-2">Sistema de Estudos ENARE 2026</p>
            </div>

            <!-- Tabs -->
            <div class="flex mb-6 bg-gray-100 rounded-lg p-1">
                <button onclick="mostrarLogin()" id="tab-login" class="flex-1 py-2 rounded-lg font-semibold transition bg-white text-indigo-600 shadow">
                    Login
                </button>
                <button onclick="mostrarRegistro()" id="tab-registro" class="flex-1 py-2 rounded-lg font-semibold transition text-gray-600">
                    Criar Conta
                </button>
            </div>

            <!-- Formulário de Login -->
            <form id="form-login" class="space-y-4">
                <div>
                    <label class="block text-gray-700 font-semibold mb-2">Email</label>
                    <input type="email" id="login-email" required
                        class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="seu@email.com">
                </div>
                <div>
                    <label class="block text-gray-700 font-semibold mb-2">Senha</label>
                    <input type="password" id="login-senha" required
                        class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="••••••••">
                </div>
                <button type="submit"
                    class="w-full bg-indigo-600 text-white py-3 rounded-lg font-bold hover:bg-indigo-700 transition">
                    <i class="fas fa-sign-in-alt mr-2"></i>Entrar
                </button>
            </form>

            <!-- Formulário de Registro -->
            <form id="form-registro" class="space-y-4 hidden">
                <div>
                    <label class="block text-gray-700 font-semibold mb-2">Nome Completo</label>
                    <input type="text" id="registro-nome" required
                        class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="Seu nome">
                </div>
                <div>
                    <label class="block text-gray-700 font-semibold mb-2">Email</label>
                    <input type="email" id="registro-email" required
                        class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="seu@email.com">
                </div>
                <div>
                    <label class="block text-gray-700 font-semibold mb-2">Senha</label>
                    <input type="password" id="registro-senha" required
                        class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="Mínimo 6 caracteres">
                </div>
                <div>
                    <label class="block text-gray-700 font-semibold mb-2">Data da Prova (opcional)</label>
                    <input type="date" id="registro-data-prova"
                        class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500">
                </div>
                <button type="submit"
                    class="w-full bg-green-600 text-white py-3 rounded-lg font-bold hover:bg-green-700 transition">
                    <i class="fas fa-user-plus mr-2"></i>Criar Conta
                </button>
            </form>

            <div class="mt-6 text-center">
                <a href="/home" class="text-indigo-600 hover:text-indigo-700 font-semibold">
                    <i class="fas fa-arrow-left mr-1"></i>Voltar para Home
                </a>
            </div>

            <div id="mensagem" class="mt-4 p-3 rounded-lg hidden"></div>
        </div>

        <script>
        function mostrarLogin() {
            document.getElementById('form-login').classList.remove('hidden')
            document.getElementById('form-registro').classList.add('hidden')
            document.getElementById('tab-login').classList.add('bg-white', 'text-indigo-600', 'shadow')
            document.getElementById('tab-login').classList.remove('text-gray-600')
            document.getElementById('tab-registro').classList.remove('bg-white', 'text-indigo-600', 'shadow')
            document.getElementById('tab-registro').classList.add('text-gray-600')
        }

        function mostrarRegistro() {
            document.getElementById('form-login').classList.add('hidden')
            document.getElementById('form-registro').classList.remove('hidden')
            document.getElementById('tab-registro').classList.add('bg-white', 'text-indigo-600', 'shadow')
            document.getElementById('tab-registro').classList.remove('text-gray-600')
            document.getElementById('tab-login').classList.remove('bg-white', 'text-indigo-600', 'shadow')
            document.getElementById('tab-login').classList.add('text-gray-600')
        }

        function mostrarMensagem(texto, tipo) {
            const div = document.getElementById('mensagem')
            div.textContent = texto
            div.className = 'mt-4 p-3 rounded-lg ' + (tipo === 'erro' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700')
            div.classList.remove('hidden')
            setTimeout(() => div.classList.add('hidden'), 5000)
        }

        // Login
        document.getElementById('form-login').addEventListener('submit', async (e) => {
            e.preventDefault()
            const email = document.getElementById('login-email').value
            const senha = document.getElementById('login-senha').value

            try {
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, senha })
                })

                const data = await res.json()

                if (data.success) {
                    document.cookie = \`auth_token=\${data.token}; path=/; max-age=2592000\`
                    mostrarMensagem('Login realizado! Redirecionando...', 'sucesso')
                    setTimeout(() => window.location.href = '/', 1000)
                } else {
                    mostrarMensagem(data.error || 'Erro ao fazer login', 'erro')
                }
            } catch (error) {
                mostrarMensagem('Erro ao conectar com servidor', 'erro')
            }
        })

        // Registro
        document.getElementById('form-registro').addEventListener('submit', async (e) => {
            e.preventDefault()
            const nome = document.getElementById('registro-nome').value
            const email = document.getElementById('registro-email').value
            const senha = document.getElementById('registro-senha').value
            const dataProva = document.getElementById('registro-data-prova').value

            if (senha.length < 6) {
                mostrarMensagem('Senha deve ter no mínimo 6 caracteres', 'erro')
                return
            }

            try {
                const res = await fetch('/api/auth/registro', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, senha, nome, data_prova: dataProva || null })
                })

                const data = await res.json()

                if (data.success) {
                    document.cookie = \`auth_token=\${data.token}; path=/; max-age=2592000\`
                    mostrarMensagem('Conta criada! Redirecionando...', 'sucesso')
                    setTimeout(() => window.location.href = '/', 1000)
                } else {
                    mostrarMensagem(data.error || 'Erro ao criar conta', 'erro')
                }
            } catch (error) {
                mostrarMensagem('Erro ao conectar com servidor', 'erro')
            }
        })

        // Verificar parâmetro URL
        const params = new URLSearchParams(window.location.search)
        if (params.get('registro') === 'true') {
            mostrarRegistro()
        }
        </script>
    </body>
    </html>
  `)
})

export default app
