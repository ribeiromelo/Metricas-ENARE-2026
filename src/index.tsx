import { Hono } from 'hono'
import { cors } from 'hono/cors'

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
  const { DB } = c.env
  
  try {
    // 1. Verificar se já existe ciclo gerado
    const configResult = await DB.prepare('SELECT ciclo_gerado FROM configuracoes WHERE id = 1').first()
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
        INSERT INTO semanas (numero_semana, data_inicio, data_fim) 
        VALUES (?, ?, ?)
      `).bind(sg.semana, hoje, hoje).run()

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
    await DB.prepare('UPDATE configuracoes SET ciclo_gerado = 1 WHERE id = 1').run()

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
  const { DB } = c.env
  
  try {
    const config = await DB.prepare('SELECT semana_atual FROM configuracoes WHERE id = 1').first()
    const semanaAtual = config?.semana_atual || 1

    const semana = await DB.prepare(`
      SELECT * FROM semanas WHERE numero_semana = ?
    `).bind(semanaAtual).first() as Semana

    if (!semana) {
      return c.json({ error: 'Semana não encontrada' }, 404)
    }

    // Buscar temas da semana
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
// API: LISTAR TODAS AS SEMANAS
// ====================================================
app.get('/api/semanas', async (c) => {
  const { DB } = c.env
  
  try {
    const semanasResult = await DB.prepare(`
      SELECT s.*, 
        COUNT(st.id) as total_temas,
        SUM(CASE WHEN EXISTS(
          SELECT 1 FROM estudos e 
          WHERE e.semana_tema_id = st.id
        ) THEN 1 ELSE 0 END) as temas_concluidos
      FROM semanas s
      LEFT JOIN semana_temas st ON st.semana_id = s.id
      GROUP BY s.id
      ORDER BY s.numero_semana
    `).all()

    return c.json({ semanas: semanasResult.results })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// ====================================================
// API: REGISTRAR ESTUDO
// ====================================================
app.post('/api/estudo/registrar', async (c) => {
  const { DB } = c.env
  
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
      INSERT INTO estudos (tema_id, semana_tema_id, data_estudo, metodo, questoes_feitas, questoes_acertos, acuracia, tempo_minutos, observacoes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(tema_id, semana_tema_id || null, hoje, metodo, questoes_feitas || 0, questoes_acertos || 0, acuracia, tempo_minutos || 0, observacoes || null).run()

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
  const { DB } = c.env
  
  try {
    const hoje = new Date().toISOString().split('T')[0]

    const revisoesResult = await DB.prepare(`
      SELECT r.*, t.tema, t.area, t.prevalencia
      FROM revisoes r
      INNER JOIN temas t ON r.tema_id = t.id
      WHERE r.concluida = 0 AND r.data_agendada <= ?
      ORDER BY r.data_agendada ASC, t.prevalencia_numero DESC
      LIMIT 20
    `).bind(hoje).all()

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
  const { DB } = c.env
  
  try {
    // Total de estudos
    const totalEstudos = await DB.prepare('SELECT COUNT(*) as total FROM estudos').first()

    // Total de questões feitas
    const totalQuestoes = await DB.prepare('SELECT SUM(questoes_feitas) as total FROM estudos').first()

    // Acurácia média geral
    const acuraciaMedia = await DB.prepare('SELECT AVG(acuracia) as media FROM estudos WHERE acuracia > 0').first()

    // Acurácia por área
    const acuraciaPorArea = await DB.prepare(`
      SELECT t.area, AVG(e.acuracia) as media_acuracia, COUNT(e.id) as total_estudos
      FROM estudos e
      INNER JOIN temas t ON e.tema_id = t.id
      WHERE e.acuracia > 0
      GROUP BY t.area
      ORDER BY media_acuracia ASC
    `).all()

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
// FRONTEND: PÁGINA PRINCIPAL
// ====================================================
app.get('/', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>🧠 Cérebro de Estudos HardMed</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
        <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
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
                    <div class="text-right">
                        <p class="text-sm text-gray-600">Semana Atual</p>
                        <p class="text-2xl font-bold text-indigo-600" id="semana-atual">--</p>
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
        // FRONTEND JAVASCRIPT
        // ====================================================
        
        let chartAcuracia = null;

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
          const questoes = prompt('Quantas questões você fez?', '15')
          if (!questoes) return

          const acertos = prompt('Quantas você acertou?', '12')
          if (!acertos) return

          const tempo = prompt('Tempo em minutos?', '60')
          if (!tempo) return

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
              alert('Estudo registrado! Acurácia: ' + data.acuracia.toFixed(1) + '%')
              loadDashboard()
            } else {
              alert('Erro: ' + data.error)
            }
          } catch (error) {
            alert('Erro ao registrar estudo')
          }
        }

        // Concluir revisão
        async function concluirRevisao(revisaoId) {
          const acuracia = prompt('Qual foi sua acurácia na revisão? (0-100)', '80')
          if (!acuracia) return

          try {
            const res = await fetch(\`/api/revisao/concluir/\${revisaoId}\`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ acuracia_revisao: parseFloat(acuracia) })
            })

            const data = await res.json()
            if (data.success) {
              alert('Revisão concluída!')
              loadDashboard()
            } else {
              alert('Erro: ' + data.error)
            }
          } catch (error) {
            alert('Erro ao concluir revisão')
          }
        }

        // Gerar ciclo
        async function gerarCiclo() {
          if (!confirm('Gerar o ciclo de 40 semanas? Esta operação só pode ser feita uma vez.')) return

          try {
            const res = await fetch('/api/ciclo/gerar', { method: 'POST' })
            const data = await res.json()
            
            if (data.success) {
              alert('Ciclo gerado com sucesso! ' + data.semanas + ' semanas criadas.')
              loadSemanas()
            } else {
              alert('Erro: ' + data.error)
            }
          } catch (error) {
            alert('Erro ao gerar ciclo')
          }
        }

        // Carregar semanas
        async function loadSemanas() {
          try {
            const res = await fetch('/api/semanas')
            const data = await res.json()
            
            const mapaDiv = document.getElementById('mapa-semanas')
            if (data.semanas && data.semanas.length > 0) {
              mapaDiv.innerHTML = data.semanas.map(s => \`
                <div class="border rounded-lg p-4 \${s.concluida ? 'bg-green-50 border-green-300' : 'bg-white border-gray-200'}">
                  <h3 class="font-bold text-gray-800">Semana \${s.numero_semana}</h3>
                  <p class="text-sm text-gray-600">\${s.total_temas || 0} temas</p>
                  <p class="text-xs text-gray-500 mt-2">\${s.temas_concluidos || 0}/\${s.total_temas || 0} concluídos</p>
                </div>
              \`).join('')
            } else {
              mapaDiv.innerHTML = '<p class="text-gray-600 col-span-4">Nenhuma semana gerada. Clique em "Gerar Ciclo Agora".</p>'
            }
          } catch (error) {
            console.error('Erro ao carregar semanas:', error)
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

export default app
