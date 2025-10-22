import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

// ====================================================
// HELPER: DATA/HORA DO BRASIL (UTC-3)
// ====================================================
function getDataBrasil(): Date {
  // Cria data atual em UTC e ajusta para Brasil (UTC-3)
  const agora = new Date()
  const brazilTime = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
  return brazilTime
}

function formatarDataBR(dataISO: string): string {
  const data = new Date(dataISO + 'T00:00:00-03:00') // Force Brazil timezone
  return data.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
}

function getDataISOBrasil(diasParaAdicionar: number = 0): string {
  const data = getDataBrasil()
  data.setDate(data.getDate() + diasParaAdicionar)
  // Retorna apenas a parte da data no formato YYYY-MM-DD
  const ano = data.getFullYear()
  const mes = String(data.getMonth() + 1).padStart(2, '0')
  const dia = String(data.getDate()).padStart(2, '0')
  return `${ano}-${mes}-${dia}`
}

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

    // 5. Inserir no banco usando BATCH para performance
    const hoje = new Date().toISOString().split('T')[0]
    
    // Usar batch do D1 para inserir todas as semanas de uma vez
    const batchStatements = []
    
    for (const sg of semanasGeradas) {
      // Preparar INSERT de semana
      batchStatements.push(
        DB.prepare(`
          INSERT INTO semanas (numero_semana, data_inicio, data_fim, usuario_id) 
          VALUES (?, ?, ?, ?)
        `).bind(sg.semana, hoje, hoje, usuarioId)
      )
    }
    
    // Executar batch de semanas
    const semanaResults = await DB.batch(batchStatements)
    
    // Agora inserir semana_temas em batch também
    const temasBatchStatements = []
    
    for (let idx = 0; idx < semanasGeradas.length; idx++) {
      const sg = semanasGeradas[idx]
      const semanaId = semanaResults[idx].meta.last_row_id
      
      for (let i = 0; i < sg.temas.length; i++) {
        const tema = sg.temas[i]
        const metodo = ['Clínica Médica', 'Cirurgia Geral', 'Obstetrícia', 'Ginecologia'].includes(tema.area) ? 'questoes' : 'teoria'
        
        temasBatchStatements.push(
          DB.prepare(`
            INSERT INTO semana_temas (semana_id, tema_id, ordem, metodo, meta_questoes, meta_tempo_minutos)
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(semanaId, tema.id, i + 1, metodo, 15, 60)
        )
      }
    }
    
    // Executar batch de temas (dividir em chunks de 50 para não exceder limites)
    const chunkSize = 50
    for (let i = 0; i < temasBatchStatements.length; i += chunkSize) {
      const chunk = temasBatchStatements.slice(i, i + chunkSize)
      await DB.batch(chunk)
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
    // Adiciona coluna 'ja_estudado' (COUNT de estudos para cada TEMA, não semana_tema)
    const temasResult = await DB.prepare(`
      SELECT st.*, t.*, 
        (SELECT COUNT(*) FROM estudos e WHERE e.tema_id = t.id AND e.usuario_id = ?) as ja_estudado
      FROM semana_temas st
      INNER JOIN temas t ON st.tema_id = t.id
      WHERE st.semana_id = ?
      ORDER BY st.ordem
    `).bind(usuarioId, semana.id).all()

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
    // CRITICAL FIX: Count completed themes by tema_id (not semana_tema_id)
    // Same theme studied in any week should count as completed
    const semanasResult = await DB.prepare(`
      SELECT s.*, 
        COUNT(st.id) as total_temas,
        SUM(CASE WHEN EXISTS(
          SELECT 1 FROM estudos e 
          WHERE e.tema_id = st.tema_id AND e.usuario_id = ?
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
    const hoje = getDataISOBrasil() // Use Brazil timezone

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

    // Criar revisões com intervalos cumulativos usando timezone do Brasil
    let diasAcumulados = 0
    for (let i = 0; i < intervalos.length; i++) {
      diasAcumulados += intervalos[i]
      const dataAgendada = getDataISOBrasil(diasAcumulados) // Use Brazil timezone
      
      await DB.prepare(`
        INSERT INTO revisoes (estudo_id, tema_id, numero_revisao, data_agendada, intervalo_dias)
        VALUES (?, ?, ?, ?, ?)
      `).bind(estudoId, tema_id, i + 1, dataAgendada, intervalos[i]).run()
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

  // GARANTIR que o primeiro intervalo seja sempre no mínimo 1 dia
  intervalos = intervalos.map(i => Math.max(1, i))

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
    const hoje = getDataISOBrasil() // Use Brazil timezone

    const revisoesResult = await DB.prepare(`
      SELECT r.*, t.tema, t.area, t.prevalencia, t.prevalencia_numero
      FROM revisoes r
      INNER JOIN temas t ON r.tema_id = t.id
      INNER JOIN estudos e ON r.estudo_id = e.id
      WHERE r.concluida = 0 AND e.usuario_id = ?
      ORDER BY r.data_agendada ASC, t.prevalencia_numero DESC
      LIMIT 20
    `).bind(usuarioId).all()

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
    const { 
      acuracia_revisao, 
      metodo, 
      tema_id, 
      prevalencia_numero,
      questoes_feitas,
      questoes_acertos,
      dificuldade
    } = body

    const hoje = getDataISOBrasil() // Use Brazil timezone

    // Marcar revisão como concluída
    await DB.prepare(`
      UPDATE revisoes 
      SET concluida = 1, data_realizada = ?, acuracia_revisao = ?
      WHERE id = ?
    `).bind(hoje, acuracia_revisao || null, id).run()

    // Buscar informações da revisão atual
    const revisaoAtual = await DB.prepare(`
      SELECT numero_revisao, estudo_id FROM revisoes WHERE id = ?
    `).bind(id).first()

    // Calcular próximos intervalos baseado em prevalência e performance
    const intervalos = calcularProximasRevisoes(
      prevalencia_numero, 
      acuracia_revisao, 
      revisaoAtual.numero_revisao
    )

    // Criar novas revisões com intervalos cumulativos usando timezone do Brasil
    let diasAcumulados = 0
    for (let i = 0; i < intervalos.length; i++) {
      diasAcumulados += intervalos[i]
      const dataAgendada = getDataISOBrasil(diasAcumulados) // Use Brazil timezone
      
      await DB.prepare(`
        INSERT INTO revisoes (estudo_id, tema_id, numero_revisao, data_agendada, intervalo_dias)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        revisaoAtual.estudo_id, 
        tema_id, 
        revisaoAtual.numero_revisao + i + 1, 
        dataAgendada, 
        intervalos[i]
      ).run()
    }

    return c.json({ success: true })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// ====================================================
// FUNÇÃO: CALCULAR PRÓXIMAS REVISÕES
// ====================================================
function calcularProximasRevisoes(
  prevalencia: number, 
  acuracia: number, 
  numeroRevisaoAtual: number
): number[] {
  // Intervalos base progressivos: 3d → 7d → 15d → 30d → 60d
  let intervalos = [3, 7, 15, 30, 60]

  // Limitar revisões: máximo 3 próximas revisões por vez
  const maxRevisoes = 3

  // Ajuste por prevalência (ALTA = 5, MÉDIA = 3, BAIXA = 1)
  let fatorPrevalencia = 1.0
  if (prevalencia === 5) {
    fatorPrevalencia = 0.7 // Revisar 30% mais rápido
  } else if (prevalencia === 1) {
    fatorPrevalencia = 1.3 // Revisar 30% mais devagar
  }

  // Ajuste por acurácia/dificuldade
  let fatorPerformance = 1.0
  if (acuracia < 70) {
    // Baixa performance: revisar 50% mais rápido
    fatorPerformance = 0.5
  } else if (acuracia >= 90) {
    // Alta performance: revisar 40% mais devagar
    fatorPerformance = 1.4
  }

  // Aplicar fatores
  intervalos = intervalos.map(i => 
    Math.max(1, Math.floor(i * fatorPrevalencia * fatorPerformance))
  )

  // Retornar apenas as próximas revisões (não todas de uma vez)
  return intervalos.slice(0, maxRevisoes)
}

// ====================================================
// API: MÉTRICAS GERAIS
// ====================================================
app.get('/api/metricas', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const usuarioId = auth.usuario.usuario_id
  
  try {
    const hoje = getDataISOBrasil()

    // ============ MÉTRICAS BÁSICAS (OTIMIZADO - SINGLE QUERY) ============
    
    // Combinar métricas básicas em uma única query
    const metricasBasicas = await DB.prepare(`
      SELECT 
        COUNT(*) as total_estudos,
        COALESCE(SUM(questoes_feitas), 0) as total_questoes,
        COALESCE(SUM(tempo_minutos), 0) as tempo_total_minutos,
        COALESCE(AVG(CASE WHEN acuracia > 0 THEN acuracia ELSE NULL END), 0) as acuracia_media,
        COUNT(DISTINCT data_estudo) as dias_com_estudo
      FROM estudos 
      WHERE usuario_id = ?
    `).bind(usuarioId).first()
    
    const totalEstudos = { total: metricasBasicas?.total_estudos || 0 }
    const totalQuestoes = { total: metricasBasicas?.total_questoes || 0 }
    const horasTotais = { total: metricasBasicas?.tempo_total_minutos || 0 }
    const acuraciaMedia = { media: metricasBasicas?.acuracia_media || 0 }
    const diasComEstudo = { dias: metricasBasicas?.dias_com_estudo || 0 }

    // ============ STREAK E CONSISTÊNCIA ============
    
    // Dias de estudo consecutivos (streak)
    const diasEstudo = await DB.prepare(`
      SELECT DISTINCT data_estudo FROM estudos 
      WHERE usuario_id = ? 
      ORDER BY data_estudo DESC
      LIMIT 30
    `).bind(usuarioId).all()
    
    let streak = 0
    if (diasEstudo.results.length > 0) {
      const dataHoje = new Date(hoje)
      let dataVerificar = new Date(hoje)
      
      for (const registro of diasEstudo.results) {
        const dataEstudo = new Date(registro.data_estudo)
        const diffDias = Math.floor((dataVerificar.getTime() - dataEstudo.getTime()) / (1000 * 60 * 60 * 24))
        
        if (diffDias <= 1) {
          streak++
          dataVerificar = dataEstudo
        } else {
          break
        }
      }
    }

    // Média de questões por dia (já calculada acima em metricasBasicas)
    const mediaDiaria = diasComEstudo?.dias > 0 ? (totalQuestoes?.total || 0) / diasComEstudo.dias : 0

    // ============ REVISÕES (OTIMIZADO - SINGLE QUERY) ============
    
    // Combinar todas as métricas de revisão em uma única query
    const metricasRevisoes = await DB.prepare(`
      SELECT 
        COUNT(CASE WHEN r.concluida = 0 AND r.data_agendada <= ? THEN 1 END) as pendentes,
        COUNT(CASE WHEN r.concluida = 1 THEN 1 END) as concluidas,
        COUNT(CASE WHEN r.concluida = 1 AND r.acuracia_revisao >= 70 THEN 1 END) as com_sucesso,
        COUNT(CASE WHEN r.concluida = 0 AND r.data_agendada < ? THEN 1 END) as atrasadas
      FROM revisoes r
      INNER JOIN estudos e ON r.estudo_id = e.id
      WHERE e.usuario_id = ?
    `).bind(hoje, hoje, usuarioId).first()
    
    const revisoesPendentes = { total: metricasRevisoes?.pendentes || 0 }
    const revisoesConcluidas = { total: metricasRevisoes?.concluidas || 0 }
    const revisoesComSucesso = { total: metricasRevisoes?.com_sucesso || 0 }
    const revisoesAtrasadas = { total: metricasRevisoes?.atrasadas || 0 }
    const taxaSucessoRevisoes = (revisoesConcluidas?.total || 0) > 0 
      ? ((revisoesComSucesso?.total || 0) / revisoesConcluidas.total) * 100 
      : 0

    // ============ ANÁLISE POR ÁREA ============
    
    // Acurácia por área
    const acuraciaPorArea = await DB.prepare(`
      SELECT t.area, AVG(e.acuracia) as media_acuracia, COUNT(e.id) as total_estudos
      FROM estudos e
      INNER JOIN temas t ON e.tema_id = t.id
      WHERE e.acuracia > 0 AND e.usuario_id = ?
      GROUP BY t.area
      ORDER BY media_acuracia DESC
    `).bind(usuarioId).all()

    // Distribuição de estudos por área (para gráfico pizza)
    const distribuicaoPorArea = await DB.prepare(`
      SELECT t.area, COUNT(e.id) as total
      FROM estudos e
      INNER JOIN temas t ON e.tema_id = t.id
      WHERE e.usuario_id = ?
      GROUP BY t.area
      ORDER BY total DESC
    `).bind(usuarioId).all()

    // ============ ANÁLISE POR PREVALÊNCIA ============
    
    const performancePorPrevalencia = await DB.prepare(`
      SELECT t.prevalencia, AVG(e.acuracia) as media_acuracia, COUNT(e.id) as total_estudos
      FROM estudos e
      INNER JOIN temas t ON e.tema_id = t.id
      WHERE e.acuracia > 0 AND e.usuario_id = ?
      GROUP BY t.prevalencia
      ORDER BY t.prevalencia_numero DESC
    `).bind(usuarioId).all()

    // ============ TEMAS E RANKINGS ============
    
    // Temas mais errados (<70%)
    const temasMaisErrados = await DB.prepare(`
      SELECT t.tema, t.area, AVG(e.acuracia) as media_acuracia, COUNT(e.id) as vezes_estudado
      FROM estudos e
      INNER JOIN temas t ON e.tema_id = t.id
      WHERE e.acuracia > 0 AND e.usuario_id = ?
      GROUP BY e.tema_id
      HAVING AVG(e.acuracia) < 70
      ORDER BY media_acuracia ASC
      LIMIT 10
    `).bind(usuarioId).all()

    // Temas dominados (>90%)
    const temasDominados = await DB.prepare(`
      SELECT t.tema, t.area, AVG(e.acuracia) as media_acuracia, COUNT(e.id) as vezes_estudado
      FROM estudos e
      INNER JOIN temas t ON e.tema_id = t.id
      WHERE e.acuracia > 0 AND e.usuario_id = ?
      GROUP BY e.tema_id
      HAVING AVG(e.acuracia) >= 90
      ORDER BY media_acuracia DESC
      LIMIT 10
    `).bind(usuarioId).all()

    // Temas mais revisados
    const temasMaisRevisados = await DB.prepare(`
      SELECT t.tema, t.area, COUNT(r.id) as total_revisoes
      FROM revisoes r
      INNER JOIN temas t ON r.tema_id = t.id
      INNER JOIN estudos e ON r.estudo_id = e.id
      WHERE e.usuario_id = ?
      GROUP BY r.tema_id
      ORDER BY total_revisoes DESC
      LIMIT 10
    `).bind(usuarioId).all()

    // ============ PROGRESSO DO CICLO (OTIMIZADO - SINGLE QUERY) ============
    
    const progressoCiclo = await DB.prepare(`
      SELECT 
        (SELECT COUNT(*) FROM semanas WHERE usuario_id = ?) as total_semanas,
        (SELECT COUNT(*) FROM semana_temas st INNER JOIN semanas s ON st.semana_id = s.id WHERE s.usuario_id = ?) as temas_total_ciclo,
        (SELECT COUNT(DISTINCT tema_id) FROM estudos WHERE usuario_id = ?) as temas_estudados
    `).bind(usuarioId, usuarioId, usuarioId).first()
    
    const totalSemanas = { total: progressoCiclo?.total_semanas || 0 }
    const temasTotaisCiclo = { total: progressoCiclo?.temas_total_ciclo || 0 }
    const temasEstudados = { total: progressoCiclo?.temas_estudados || 0 }
    
    const percentualConclusao = (temasTotaisCiclo?.total || 0) > 0 
      ? ((temasEstudados?.total || 0) / temasTotaisCiclo.total) * 100 
      : 0

    // ============ EVOLUÇÃO TEMPORAL ============
    
    // Estudos dos últimos 7 dias
    const estudosUltimos7Dias = await DB.prepare(`
      SELECT data_estudo, COUNT(*) as total, SUM(tempo_minutos) as tempo_total
      FROM estudos
      WHERE usuario_id = ?
      GROUP BY data_estudo
      ORDER BY data_estudo DESC
      LIMIT 7
    `).bind(usuarioId).all()

    // Evolução da acurácia (últimas 10 sessões)
    const evolucaoAcuracia = await DB.prepare(`
      SELECT data_estudo, AVG(acuracia) as media_acuracia
      FROM estudos
      WHERE acuracia > 0 AND usuario_id = ?
      GROUP BY data_estudo
      ORDER BY data_estudo DESC
      LIMIT 10
    `).bind(usuarioId).all()

    // ============ METAS DE QUESTÕES (ENARE 2026) ============
    
    // Buscar data da prova do usuário
    const usuario = await DB.prepare('SELECT data_prova FROM usuarios WHERE id = ?').bind(usuarioId).first()
    const dataProva = usuario?.data_prova || '2026-09-30' // Default: setembro/2026
    
    // Calcular checkpoints trimestrais
    const dataProvaDate = new Date(dataProva)
    const dataInicio = new Date(hoje)
    
    // Metas trimestrais fixas até setembro/2026
    const checkpoints = [
      { trimestre: 'Março/2025', data: '2025-03-31', meta: 3000 },
      { trimestre: 'Junho/2025', data: '2025-06-30', meta: 6000 },
      { trimestre: 'Setembro/2025', data: '2025-09-30', meta: 9000 },
      { trimestre: 'Dezembro/2025', data: '2025-12-31', meta: 12000 },
      { trimestre: 'Setembro/2026', data: '2026-09-30', meta: 15000 }
    ]
    
    // Encontrar próximo checkpoint
    let proximoCheckpoint = null
    let checkpointAtual = null
    const dataHoje = new Date(hoje)
    
    for (let i = 0; i < checkpoints.length; i++) {
      const checkDate = new Date(checkpoints[i].data)
      if (dataHoje <= checkDate) {
        proximoCheckpoint = checkpoints[i]
        checkpointAtual = i > 0 ? checkpoints[i - 1] : null
        break
      }
    }
    
    if (!proximoCheckpoint) {
      proximoCheckpoint = checkpoints[checkpoints.length - 1]
      checkpointAtual = checkpoints[checkpoints.length - 2]
    }
    
    // Calcular progresso até próximo checkpoint
    const questoesFeitas = totalQuestoes?.total || 0
    const metaProximoCheckpoint = proximoCheckpoint.meta
    const percentualMeta = (questoesFeitas / 15000) * 100
    const percentualCheckpoint = (questoesFeitas / metaProximoCheckpoint) * 100
    
    // Calcular ritmo (questões por dia desde o início)
    const diasEstudadosTotal = diasComEstudo?.dias || 1
    const ritmoAtual = questoesFeitas / diasEstudadosTotal
    
    // Calcular dias até a prova
    const diasAteProva = Math.floor((dataProvaDate.getTime() - dataHoje.getTime()) / (1000 * 60 * 60 * 24))
    
    // Calcular ritmo necessário
    const questoesFaltam = 15000 - questoesFeitas
    const ritmoNecessario = diasAteProva > 0 ? questoesFaltam / diasAteProva : 0
    
    // Projeção: se continuar no ritmo atual, quantas questões terá em set/2026?
    const projecaoFinal = diasAteProva > 0 ? questoesFeitas + (ritmoAtual * diasAteProva) : questoesFeitas
    
    // Questões por mês (últimos 3 meses)
    const questoesPorMes = await DB.prepare(`
      SELECT 
        strftime('%Y-%m', data_estudo) as mes,
        SUM(questoes_feitas) as total
      FROM estudos
      WHERE usuario_id = ?
      GROUP BY strftime('%Y-%m', data_estudo)
      ORDER BY mes DESC
      LIMIT 3
    `).bind(usuarioId).all()
    
    // Calcular meta mensal (15000 questões / meses até prova)
    const mesesAteProva = Math.ceil(diasAteProva / 30)
    const metaMensal = mesesAteProva > 0 ? Math.ceil(questoesFaltam / mesesAteProva) : 0

    return c.json({
      // Métricas básicas
      total_estudos: totalEstudos?.total || 0,
      total_questoes: totalQuestoes?.total || 0,
      horas_totais: Math.round((horasTotais?.total || 0) / 60 * 10) / 10,
      acuracia_media: acuraciaMedia?.media || 0,
      
      // Streak e consistência
      streak_dias: streak,
      media_questoes_dia: Math.round(mediaDiaria * 10) / 10,
      
      // Revisões
      revisoes_pendentes: revisoesPendentes?.total || 0,
      revisoes_concluidas: revisoesConcluidas?.total || 0,
      taxa_sucesso_revisoes: Math.round(taxaSucessoRevisoes * 10) / 10,
      revisoes_atrasadas: revisoesAtrasadas?.total || 0,
      
      // Por área
      acuracia_por_area: acuraciaPorArea.results,
      distribuicao_por_area: distribuicaoPorArea.results,
      
      // Por prevalência
      performance_por_prevalencia: performancePorPrevalencia.results,
      
      // Rankings
      temas_mais_errados: temasMaisErrados.results,
      temas_dominados: temasDominados.results,
      temas_mais_revisados: temasMaisRevisados.results,
      
      // Progresso do ciclo
      total_semanas_ciclo: totalSemanas?.total || 0,
      temas_totais_ciclo: temasTotaisCiclo?.total || 0,
      temas_estudados: temasEstudados?.total || 0,
      percentual_conclusao: Math.round(percentualConclusao * 10) / 10,
      
      // Evolução temporal
      estudos_ultimos_7_dias: estudosUltimos7Dias.results.reverse(),
      evolucao_acuracia: evolucaoAcuracia.results.reverse(),
      
      // Metas de questões (ENARE 2026)
      meta_questoes: {
        total_questoes: questoesFeitas,
        meta_final: 15000,
        percentual_meta: Math.round(percentualMeta * 10) / 10,
        proximo_checkpoint: proximoCheckpoint,
        checkpoint_atual: checkpointAtual,
        percentual_checkpoint: Math.round(percentualCheckpoint * 10) / 10,
        checkpoints: checkpoints,
        ritmo_atual: Math.round(ritmoAtual * 10) / 10,
        ritmo_necessario: Math.round(ritmoNecessario * 10) / 10,
        dias_ate_prova: diasAteProva,
        projecao_final: Math.round(projecaoFinal),
        questoes_faltam: questoesFaltam,
        meta_mensal: metaMensal,
        questoes_por_mes: questoesPorMes.results.reverse(),
        no_caminho_certo: projecaoFinal >= 15000
      }
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

// ====================================================
// IMPORTAR TEMAS (endpoint temporário - REMOVER DEPOIS)
// ====================================================
app.post('/api/import-temas', async (c) => {
  const { DB } = c.env
  
  try {
    // Verificar se já existem temas
    const count = await DB.prepare('SELECT COUNT(*) as total FROM temas').first()
    
    if (count && count.total > 0) {
      return c.json({ error: 'Temas já foram importados anteriormente', total: count.total }, 400)
    }

    // Receber array de temas do body
    const { temas } = await c.req.json()
    
    if (!temas || !Array.isArray(temas)) {
      return c.json({ error: 'Body deve conter array "temas"' }, 400)
    }

    // Inserir todos os temas
    let inserted = 0
    for (const tema of temas) {
      await DB.prepare(`
        INSERT INTO temas (area, subarea, tema, subtopicos, prevalencia, prevalencia_numero, prioridade, origem, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        tema.area,
        tema.subarea,
        tema.tema,
        tema.subtopicos || '',
        tema.prevalencia,
        tema.prevalencia_numero,
        tema.prioridade || 1,
        tema.origem || '',
        tema.observacoes || ''
      ).run()
      inserted++
    }
    
    return c.json({ success: true, temas_importados: inserted })

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
            
            /* Animação de brilho no header */
            @keyframes shimmer {
                0% {
                    transform: translateX(-100%);
                }
                100% {
                    transform: translateX(100%);
                }
            }
            .animate-shimmer {
                animation: shimmer 3s infinite;
            }
            
            /* Efeito glassmorphism aprimorado */
            .backdrop-blur-sm {
                backdrop-filter: blur(8px);
                -webkit-backdrop-filter: blur(8px);
            }
        </style>
    </head>
    <body class="bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen">
        <!-- Header -->
        <header class="bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 shadow-2xl relative overflow-hidden">
            <!-- Efeito de brilho animado -->
            <div class="absolute inset-0 bg-gradient-to-r from-transparent via-white to-transparent opacity-10 animate-shimmer"></div>
            
            <div class="max-w-7xl mx-auto px-4 py-8 relative z-10">
                <div class="flex items-center justify-between">
                    <!-- Logo e Título -->
                    <div class="flex items-center space-x-5">
                        <div class="bg-white bg-opacity-20 backdrop-blur-sm p-4 rounded-2xl shadow-xl transform hover:scale-110 transition-all duration-300">
                            <i class="fas fa-brain text-white text-4xl"></i>
                        </div>
                        <div>
                            <h1 class="text-4xl font-extrabold text-white tracking-tight drop-shadow-lg">
                                Cérebro de Estudos HardMed
                            </h1>
                            <p class="text-indigo-100 text-lg font-medium mt-1 drop-shadow">
                                <i class="fas fa-graduation-cap mr-2"></i>Sistema Inteligente de Revisões ENARE
                            </p>
                        </div>
                    </div>
                    
                    <!-- Ações do Header -->
                    <div class="flex items-center space-x-6">
                        <!-- Semana Atual -->
                        <div class="bg-white bg-opacity-20 backdrop-blur-sm rounded-2xl px-6 py-3 shadow-xl border border-white border-opacity-30">
                            <p class="text-indigo-100 text-sm font-semibold mb-1">Semana Atual</p>
                            <p class="text-3xl font-bold text-white" id="semana-atual">--</p>
                        </div>
                        
                        <!-- Controles -->
                        <div class="flex items-center space-x-4">
                            <!-- Botão de Tema -->
                            <button onclick="toggleTheme()" 
                                    class="bg-white bg-opacity-20 backdrop-blur-sm hover:bg-opacity-30 px-5 py-3 rounded-xl transition-all duration-300 shadow-lg border border-white border-opacity-30 transform hover:scale-105" 
                                    title="Alternar tema">
                                <i id="theme-icon" class="fas fa-moon text-white text-xl"></i>
                            </button>
                            
                            <!-- Info do Usuário -->
                            <div class="bg-white bg-opacity-20 backdrop-blur-sm rounded-2xl px-6 py-3 shadow-xl border border-white border-opacity-30">
                                <p class="text-indigo-100 text-sm font-semibold mb-1">
                                    <i class="fas fa-user-circle mr-2"></i>Olá, ${nomeUsuario}!
                                </p>
                                <button onclick="logout()" 
                                        class="text-sm text-white hover:text-red-200 font-bold transition-colors duration-200 flex items-center group">
                                    <i class="fas fa-sign-out-alt mr-2 group-hover:scale-110 transition-transform"></i>
                                    Sair
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Linha decorativa inferior -->
            <div class="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r from-yellow-300 via-pink-300 to-purple-300"></div>
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
                <!-- Cards de Métricas Principais -->
                <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                    <div class="bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl shadow-lg p-4 text-white">
                        <div class="flex items-center justify-between mb-2">
                            <i class="fas fa-fire text-3xl opacity-80"></i>
                            <span id="metric-streak" class="text-3xl font-bold">--</span>
                        </div>
                        <p class="text-sm opacity-90">Dias Consecutivos</p>
                    </div>
                    <div class="bg-gradient-to-br from-purple-500 to-purple-600 rounded-xl shadow-lg p-4 text-white">
                        <div class="flex items-center justify-between mb-2">
                            <i class="fas fa-clock text-3xl opacity-80"></i>
                            <span id="metric-horas" class="text-3xl font-bold">--</span>
                        </div>
                        <p class="text-sm opacity-90">Horas de Estudo</p>
                    </div>
                    <div class="bg-gradient-to-br from-green-500 to-green-600 rounded-xl shadow-lg p-4 text-white">
                        <div class="flex items-center justify-between mb-2">
                            <i class="fas fa-check-double text-3xl opacity-80"></i>
                            <span id="metric-revisoes-sucesso" class="text-3xl font-bold">--</span>
                        </div>
                        <p class="text-sm opacity-90">Taxa Sucesso Revisões</p>
                    </div>
                    <div class="bg-gradient-to-br from-orange-500 to-orange-600 rounded-xl shadow-lg p-4 text-white">
                        <div class="flex items-center justify-between mb-2">
                            <i class="fas fa-trophy text-3xl opacity-80"></i>
                            <span id="metric-conclusao" class="text-3xl font-bold">--</span>
                        </div>
                        <p class="text-sm opacity-90">Conclusão do Ciclo</p>
                    </div>
                </div>

                <!-- META DE QUESTÕES ENARE 2026 -->
                <div class="bg-gradient-to-r from-indigo-600 to-purple-600 rounded-xl shadow-2xl p-8 mb-6 text-white">
                    <div class="flex items-center justify-between mb-6">
                        <div>
                            <h2 class="text-3xl font-bold mb-2">
                                <i class="fas fa-bullseye mr-3"></i>Meta ENARE 2026
                            </h2>
                            <p class="text-indigo-100">15.000 questões até setembro de 2026</p>
                        </div>
                        <div class="text-right">
                            <p class="text-5xl font-bold" id="meta-questoes-total">--</p>
                            <p class="text-indigo-100">questões feitas</p>
                        </div>
                    </div>

                    <!-- Barra de Progresso -->
                    <div class="mb-6">
                        <div class="flex items-center justify-between mb-2">
                            <span class="font-semibold">Progresso Total</span>
                            <span class="font-bold text-2xl" id="meta-percentual">--%</span>
                        </div>
                        <div class="w-full bg-white bg-opacity-20 rounded-full h-6 overflow-hidden">
                            <div id="meta-barra" class="bg-white h-full rounded-full transition-all duration-1000" style="width: 0%"></div>
                        </div>
                        <div class="flex items-center justify-between mt-2 text-sm text-indigo-100">
                            <span>0</span>
                            <span>15.000</span>
                        </div>
                    </div>

                    <!-- Checkpoints e Status -->
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                        <div class="bg-white bg-opacity-10 rounded-lg p-4 backdrop-blur-sm">
                            <p class="text-sm text-indigo-100 mb-1">Próximo Checkpoint</p>
                            <p class="text-2xl font-bold" id="meta-proximo-checkpoint">--</p>
                            <p class="text-sm text-indigo-100 mt-1" id="meta-checkpoint-progresso">--%</p>
                        </div>
                        <div class="bg-white bg-opacity-10 rounded-lg p-4 backdrop-blur-sm">
                            <p class="text-sm text-indigo-100 mb-1">Ritmo Atual</p>
                            <p class="text-2xl font-bold" id="meta-ritmo-atual">--</p>
                            <p class="text-sm text-indigo-100 mt-1">questões/dia</p>
                        </div>
                        <div class="bg-white bg-opacity-10 rounded-lg p-4 backdrop-blur-sm">
                            <p class="text-sm text-indigo-100 mb-1">Ritmo Necessário</p>
                            <p class="text-2xl font-bold" id="meta-ritmo-necessario">--</p>
                            <p class="text-sm text-indigo-100 mt-1">questões/dia</p>
                        </div>
                    </div>

                    <!-- Status e Projeção -->
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div class="bg-white bg-opacity-10 rounded-lg p-4 backdrop-blur-sm">
                            <div class="flex items-start justify-between">
                                <div>
                                    <p class="text-sm text-indigo-100 mb-2">Status Atual</p>
                                    <p class="text-lg font-semibold" id="meta-status">--</p>
                                </div>
                                <i id="meta-status-icon" class="fas fa-chart-line text-3xl opacity-70"></i>
                            </div>
                        </div>
                        <div class="bg-white bg-opacity-10 rounded-lg p-4 backdrop-blur-sm">
                            <div class="flex items-start justify-between">
                                <div>
                                    <p class="text-sm text-indigo-100 mb-2">Projeção para Set/2026</p>
                                    <p class="text-lg font-semibold" id="meta-projecao">--</p>
                                </div>
                                <i id="meta-projecao-icon" class="fas fa-rocket text-3xl opacity-70"></i>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Gráfico de Checkpoints -->
                <div class="bg-white rounded-xl shadow-lg p-6 mb-6">
                    <h2 class="text-xl font-bold text-gray-800 mb-4">
                        <i class="fas fa-flag-checkered mr-2 text-indigo-600"></i>Checkpoints Trimestrais
                    </h2>
                    <canvas id="chartCheckpoints"></canvas>
                    <div class="mt-4 text-sm text-gray-600">
                        <p><i class="fas fa-info-circle mr-2"></i><strong>Lembre-se:</strong> Essas metas servem para ter senso de progresso, não de culpa. A constância vence o volume isolado.</p>
                    </div>
                </div>

                <!-- Gráficos -->
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                    <div class="bg-white rounded-xl shadow-lg p-6">
                        <h2 class="text-xl font-bold text-gray-800 mb-4">
                            <i class="fas fa-chart-line mr-2 text-indigo-600"></i>Evolução da Acurácia
                        </h2>
                        <canvas id="chartEvolucao"></canvas>
                    </div>
                    <div class="bg-white rounded-xl shadow-lg p-6">
                        <h2 class="text-xl font-bold text-gray-800 mb-4">
                            <i class="fas fa-chart-bar mr-2 text-indigo-600"></i>Acurácia por Área
                        </h2>
                        <canvas id="chartAcuracia"></canvas>
                    </div>
                    <div class="bg-white rounded-xl shadow-lg p-6">
                        <h2 class="text-xl font-bold text-gray-800 mb-4">
                            <i class="fas fa-chart-pie mr-2 text-indigo-600"></i>Distribuição por Área
                        </h2>
                        <canvas id="chartDistribuicao"></canvas>
                    </div>
                    <div class="bg-white rounded-xl shadow-lg p-6">
                        <h2 class="text-xl font-bold text-gray-800 mb-4">
                            <i class="fas fa-calendar-week mr-2 text-indigo-600"></i>Estudos Últimos 7 Dias
                        </h2>
                        <canvas id="chartEstudos7Dias"></canvas>
                    </div>
                </div>

                <!-- Rankings e Listas -->
                <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
                    <div class="bg-white rounded-xl shadow-lg p-6">
                        <h2 class="text-xl font-bold text-gray-800 mb-4">
                            <i class="fas fa-star mr-2 text-yellow-500"></i>Temas Dominados (>90%)
                        </h2>
                        <div id="temas-dominados" class="space-y-2 max-h-96 overflow-y-auto">
                            <p class="text-gray-600">Carregando...</p>
                        </div>
                    </div>
                    <div class="bg-white rounded-xl shadow-lg p-6">
                        <h2 class="text-xl font-bold text-gray-800 mb-4">
                            <i class="fas fa-exclamation-triangle mr-2 text-red-500"></i>Temas Mais Errados (<70%)
                        </h2>
                        <div id="temas-errados" class="space-y-2 max-h-96 overflow-y-auto">
                            <p class="text-gray-600">Carregando...</p>
                        </div>
                    </div>
                    <div class="bg-white rounded-xl shadow-lg p-6">
                        <h2 class="text-xl font-bold text-gray-800 mb-4">
                            <i class="fas fa-redo mr-2 text-purple-500"></i>Temas Mais Revisados
                        </h2>
                        <div id="temas-revisados" class="space-y-2 max-h-96 overflow-y-auto">
                            <p class="text-gray-600">Carregando...</p>
                        </div>
                    </div>
                </div>

                <!-- Performance por Prevalência -->
                <div class="bg-white rounded-xl shadow-lg p-6 mb-6">
                    <h2 class="text-xl font-bold text-gray-800 mb-4">
                        <i class="fas fa-chart-area mr-2 text-indigo-600"></i>Performance por Prevalência
                    </h2>
                    <canvas id="chartPrevalencia"></canvas>
                </div>

                <!-- Resumo do Progresso -->
                <div class="bg-white rounded-xl shadow-lg p-6">
                    <h2 class="text-xl font-bold text-gray-800 mb-4">
                        <i class="fas fa-tasks mr-2 text-indigo-600"></i>Resumo do Progresso
                    </h2>
                    <div id="resumo-progresso" class="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div class="text-center p-4 bg-gray-50 rounded-lg">
                            <p class="text-3xl font-bold text-indigo-600" id="resumo-semanas">--/--</p>
                            <p class="text-sm text-gray-600 mt-1">Semanas Completas</p>
                        </div>
                        <div class="text-center p-4 bg-gray-50 rounded-lg">
                            <p class="text-3xl font-bold text-green-600" id="resumo-temas">--/--</p>
                            <p class="text-sm text-gray-600 mt-1">Temas Estudados</p>
                        </div>
                        <div class="text-center p-4 bg-gray-50 rounded-lg">
                            <p class="text-3xl font-bold text-orange-600" id="resumo-media-dia">--</p>
                            <p class="text-sm text-gray-600 mt-1">Questões/Dia Média</p>
                        </div>
                        <div class="text-center p-4 bg-gray-50 rounded-lg">
                            <p class="text-3xl font-bold text-red-600" id="resumo-atrasadas">--</p>
                            <p class="text-sm text-gray-600 mt-1">Revisões Atrasadas</p>
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
        
        // Variáveis globais para gráficos
        let chartAcuracia = null;
        let chartEvolucao = null;
        let chartDistribuicao = null;
        let chartEstudos7Dias = null;
        let chartPrevalencia = null;

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

        // Helper: Formatar data do formato ISO para DD/MM/YYYY (Brasil)
        function formatarDataBR(dataISO) {
          if (!dataISO) return '--'
          // Adiciona timezone do Brasil para evitar conversão incorreta
          const data = new Date(dataISO + 'T00:00:00-03:00')
          const dia = String(data.getDate()).padStart(2, '0')
          const mes = String(data.getMonth() + 1).padStart(2, '0')
          const ano = data.getFullYear()
          return \`\${dia}/\${mes}/\${ano}\`
        }

        // Helper: Obter data de hoje no Brasil (UTC-3)
        function getDataHojeBrasil() {
          const agora = new Date()
          // Converter para horário do Brasil
          const brasilTime = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
          brasilTime.setHours(0, 0, 0, 0)
          return brasilTime
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
                    \${t.ja_estudado === 0 ? \`
                      <button onclick="registrarEstudo(\${t.tema_id}, \${t.id})" class="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded-lg text-sm">
                        <i class="fas fa-check mr-1"></i>Estudar
                      </button>
                    \` : \`
                      <div class="text-green-600 text-sm font-semibold">
                        <i class="fas fa-check-circle mr-1"></i>Estudado
                      </div>
                    \`}
                  </div>
                </div>
              \`).join('')
            } else {
              guiaDiv.innerHTML = '<p class="text-gray-600">Nenhum tema para hoje! 🎉</p>'
            }

            const revisoesRes = await fetch('/api/revisoes/pendentes')
            const revisoesData = await revisoesRes.json()
            
            const revisoesDiv = document.getElementById('revisoes-do-dia')
            if (revisoesData.revisoes && revisoesData.revisoes.length > 0) {
              const hoje = getDataHojeBrasil()
              
              revisoesDiv.innerHTML = revisoesData.revisoes.slice(0, 5).map(r => {
                const dataAgendada = new Date(r.data_agendada + 'T00:00:00-03:00')
                const dataFormatada = formatarDataBR(r.data_agendada)
                const podeRevisar = dataAgendada <= hoje
                
                return \`
                  <div class="border border-orange-200 rounded-lg p-3 bg-orange-50">
                    <h4 class="font-semibold text-gray-800">\${r.tema}</h4>
                    <p class="text-sm text-gray-600">\${r.area} · Revisão #\${r.numero_revisao}</p>
                    <p class="text-xs text-gray-500 mt-1">
                      <i class="fas fa-calendar mr-1"></i>Agendada para: \${dataFormatada}
                    </p>
                    \${podeRevisar ? \`
                      <button onclick="concluirRevisao(\${r.id}, \${r.tema_id}, '\${r.tema}', \${r.prevalencia_numero})" class="mt-2 bg-orange-500 hover:bg-orange-600 text-white px-3 py-1 rounded text-sm">
                        <i class="fas fa-check mr-1"></i>Marcar Revisada
                      </button>
                    \` : \`
                      <button disabled class="mt-2 bg-gray-400 text-white px-3 py-1 rounded text-sm cursor-not-allowed opacity-60">
                        <i class="fas fa-clock mr-1"></i>Aguardar data
                      </button>
                    \`}
                  </div>
                \`
              }).join('')
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
                    loadSemanas() // Atualizar mapa de semanas
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
        async function concluirRevisao(revisaoId, temaId, temaNome, prevalencia) {
          // Usar confirm do Modal para escolher método
          const overlay = document.createElement('div')
          overlay.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50'
          
          overlay.innerHTML = \`
            <div class="bg-white rounded-xl shadow-2xl max-w-md w-full mx-4 p-6">
              <div class="flex items-start space-x-4 mb-6">
                <div class="flex-shrink-0">
                  <i class="fas fa-question-circle text-indigo-500 text-4xl"></i>
                </div>
                <div class="flex-1">
                  <h3 class="text-xl font-bold text-gray-900 mb-2">Método de Revisão</h3>
                  <p class="text-gray-600">Como você revisou o tema "<strong>\${temaNome}</strong>"?</p>
                </div>
              </div>
              <div class="space-y-3">
                <button id="btn-questoes" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-3 rounded-lg font-semibold transition">
                  <i class="fas fa-question-circle mr-2"></i>Questões
                </button>
                <button id="btn-flashcard" class="w-full bg-purple-600 hover:bg-purple-700 text-white px-4 py-3 rounded-lg font-semibold transition">
                  <i class="fas fa-layer-group mr-2"></i>FlashCards ou Outro Método
                </button>
                <button id="btn-cancelar" class="w-full bg-gray-200 hover:bg-gray-300 text-gray-800 px-4 py-2 rounded-lg font-semibold transition">
                  Cancelar
                </button>
              </div>
            </div>
          \`
          
          document.body.appendChild(overlay)
          
          // Event listeners
          document.getElementById('btn-questoes').onclick = () => {
            document.body.removeChild(overlay)
            revisarPorQuestoes(revisaoId, temaId, prevalencia)
          }
          
          document.getElementById('btn-flashcard').onclick = () => {
            document.body.removeChild(overlay)
            revisarPorFlashcard(revisaoId, temaId, prevalencia)
          }
          
          document.getElementById('btn-cancelar').onclick = () => {
            document.body.removeChild(overlay)
          }
          
          overlay.onclick = (e) => {
            if (e.target === overlay) {
              document.body.removeChild(overlay)
            }
          }
        }
        
        // Revisar por questões
        async function revisarPorQuestoes(revisaoId, temaId, prevalencia) {
          Modal.input('Quantas questões você fez?', 'Ex: 10', async (questoes) => {
            if (!questoes) return
            
            Modal.input('Quantas você acertou?', 'Ex: 7', async (acertos) => {
              if (!acertos) return
              
              const acuracia = (parseInt(acertos) / parseInt(questoes)) * 100
              
              try {
                const res = await fetch(\`/api/revisao/concluir/\${revisaoId}\`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ 
                    acuracia_revisao: acuracia,
                    metodo: 'questoes',
                    questoes_feitas: parseInt(questoes),
                    questoes_acertos: parseInt(acertos),
                    tema_id: temaId,
                    prevalencia_numero: prevalencia
                  })
                })

                const data = await res.json()
                if (data.success) {
                  const msg = acuracia >= 70 
                    ? \`Revisão concluída! Acurácia: \${acuracia.toFixed(1)}% ✅\nBom desempenho! Intervalos normais aplicados.\`
                    : \`Revisão concluída! Acurácia: \${acuracia.toFixed(1)}% ⚠️\nDesempenho abaixo de 70%. Revisões mais frequentes agendadas.\`
                  
                  await Modal.alert('Sucesso!', msg, 'success')
                  loadDashboard()
                  loadRevisoes() // Atualizar lista de revisões
                } else {
                  await Modal.alert('Erro', data.error, 'error')
                }
              } catch (error) {
                await Modal.alert('Erro', 'Erro ao concluir revisão', 'error')
              }
            }, '7')
          }, '10')
        }
        
        // Revisar por flashcard
        async function revisarPorFlashcard(revisaoId, temaId, prevalencia) {
          const overlay = document.createElement('div')
          overlay.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50'
          
          overlay.innerHTML = \`
            <div class="bg-white rounded-xl shadow-2xl max-w-md w-full mx-4 p-6">
              <div class="flex items-start space-x-4 mb-6">
                <div class="flex-shrink-0">
                  <i class="fas fa-question-circle text-purple-500 text-4xl"></i>
                </div>
                <div class="flex-1">
                  <h3 class="text-xl font-bold text-gray-900 mb-2">Grau de Dificuldade</h3>
                  <p class="text-gray-600">Qual foi seu grau de dificuldade nesta revisão?</p>
                </div>
              </div>
              <div class="space-y-3">
                <button id="btn-facil" class="w-full bg-green-600 hover:bg-green-700 text-white px-4 py-3 rounded-lg font-semibold transition">
                  <i class="fas fa-smile mr-2"></i>Fácil - Domino bem o tema
                </button>
                <button id="btn-medio" class="w-full bg-yellow-600 hover:bg-yellow-700 text-white px-4 py-3 rounded-lg font-semibold transition">
                  <i class="fas fa-meh mr-2"></i>Médio - Lembro com esforço
                </button>
                <button id="btn-dificil" class="w-full bg-red-600 hover:bg-red-700 text-white px-4 py-3 rounded-lg font-semibold transition">
                  <i class="fas fa-frown mr-2"></i>Difícil - Preciso revisar mais
                </button>
                <button id="btn-cancelar-flash" class="w-full bg-gray-200 hover:bg-gray-300 text-gray-800 px-4 py-2 rounded-lg font-semibold transition">
                  Cancelar
                </button>
              </div>
            </div>
          \`
          
          document.body.appendChild(overlay)
          
          const processarDificuldade = async (dificuldade) => {
            document.body.removeChild(overlay)
            
            const acuraciaMap = {
              'facil': 90,
              'medio': 70,
              'dificil': 50
            }
            
            try {
              const res = await fetch(\`/api/revisao/concluir/\${revisaoId}\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                  acuracia_revisao: acuraciaMap[dificuldade],
                  metodo: 'flashcard',
                  dificuldade: dificuldade,
                  tema_id: temaId,
                  prevalencia_numero: prevalencia
                })
              })

              const data = await res.json()
              if (data.success) {
                const msgs = {
                  'facil': 'Revisão concluída! Você domina este tema. Intervalos mais longos aplicados. 😊',
                  'medio': 'Revisão concluída! Continue praticando. Intervalos moderados mantidos. 📚',
                  'dificil': 'Revisão concluída! Vamos revisar mais vezes este tema. Intervalos reduzidos. 💪'
                }
                
                await Modal.alert('Sucesso!', msgs[dificuldade], 'success')
                loadDashboard()
                loadRevisoes() // Atualizar lista de revisões
              } else {
                await Modal.alert('Erro', data.error, 'error')
              }
            } catch (error) {
              await Modal.alert('Erro', 'Erro ao concluir revisão', 'error')
            }
          }
          
          document.getElementById('btn-facil').onclick = () => processarDificuldade('facil')
          document.getElementById('btn-medio').onclick = () => processarDificuldade('medio')
          document.getElementById('btn-dificil').onclick = () => processarDificuldade('dificil')
          document.getElementById('btn-cancelar-flash').onclick = () => document.body.removeChild(overlay)
          
          overlay.onclick = (e) => {
            if (e.target === overlay) {
              document.body.removeChild(overlay)
            }
          }
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
                  loadDashboard() // Atualizar guia do dia
                  loadSemanas() // Atualizar mapa de semanas
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
              const hoje = getDataHojeBrasil()
              
              listaDiv.innerHTML = data.revisoes.map(r => {
                const dataAgendada = new Date(r.data_agendada + 'T00:00:00-03:00')
                const podeRevisar = dataAgendada <= hoje
                
                return \`
                  <div class="border border-gray-200 rounded-lg p-4">
                    <div class="flex items-start justify-between">
                      <div class="flex-1">
                        <h3 class="font-bold text-gray-800">\${r.tema}</h3>
                        <p class="text-sm text-gray-600">\${r.area} · \${r.prevalencia} · Revisão #\${r.numero_revisao}</p>
                        <p class="text-xs text-gray-500 mt-1">Agendada: \${formatarDataBR(r.data_agendada)}</p>
                      </div>
                      \${podeRevisar ? \`
                        <button onclick="concluirRevisao(\${r.id}, \${r.tema_id}, '\${r.tema}', \${r.prevalencia_numero})" class="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-lg text-sm">
                          <i class="fas fa-check mr-1"></i>Concluir
                        </button>
                      \` : \`
                        <button disabled class="bg-gray-400 text-white px-4 py-2 rounded-lg text-sm cursor-not-allowed opacity-60">
                          <i class="fas fa-clock mr-1"></i>Aguardar data
                        </button>
                      \`}
                    </div>
                  </div>
                \`
              }).join('')
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

            // ====== CARDS DE MÉTRICAS ======
            document.getElementById('metric-streak').textContent = data.streak_dias || 0
            document.getElementById('metric-horas').textContent = data.horas_totais || 0
            document.getElementById('metric-revisoes-sucesso').textContent = (data.taxa_sucesso_revisoes || 0).toFixed(1) + '%'
            document.getElementById('metric-conclusao').textContent = (data.percentual_conclusao || 0).toFixed(1) + '%'

            // ====== GRÁFICO: EVOLUÇÃO DA ACURÁCIA ======
            const ctxEvolucao = document.getElementById('chartEvolucao')
            if (chartEvolucao) chartEvolucao.destroy()

            if (data.evolucao_acuracia && data.evolucao_acuracia.length > 0) {
              chartEvolucao = new Chart(ctxEvolucao, {
                type: 'line',
                data: {
                  labels: data.evolucao_acuracia.map(e => {
                    const d = new Date(e.data_estudo)
                    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
                  }),
                  datasets: [{
                    label: 'Acurácia Média (%)',
                    data: data.evolucao_acuracia.map(e => e.media_acuracia),
                    borderColor: 'rgb(99, 102, 241)',
                    backgroundColor: 'rgba(99, 102, 241, 0.1)',
                    tension: 0.4,
                    fill: true
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

            // ====== GRÁFICO: ACURÁCIA POR ÁREA ======
            const ctxAcuracia = document.getElementById('chartAcuracia')
            if (chartAcuracia) chartAcuracia.destroy()

            if (data.acuracia_por_area && data.acuracia_por_area.length > 0) {
              chartAcuracia = new Chart(ctxAcuracia, {
                type: 'bar',
                data: {
                  labels: data.acuracia_por_area.map(a => a.area),
                  datasets: [{
                    label: 'Acurácia Média (%)',
                    data: data.acuracia_por_area.map(a => a.media_acuracia),
                    backgroundColor: 'rgba(99, 102, 241, 0.7)',
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

            // ====== GRÁFICO: DISTRIBUIÇÃO POR ÁREA (PIZZA) ======
            const ctxDistribuicao = document.getElementById('chartDistribuicao')
            if (chartDistribuicao) chartDistribuicao.destroy()

            if (data.distribuicao_por_area && data.distribuicao_por_area.length > 0) {
              chartDistribuicao = new Chart(ctxDistribuicao, {
                type: 'pie',
                data: {
                  labels: data.distribuicao_por_area.map(a => a.area),
                  datasets: [{
                    data: data.distribuicao_por_area.map(a => a.total),
                    backgroundColor: [
                      'rgba(99, 102, 241, 0.7)',
                      'rgba(147, 51, 234, 0.7)',
                      'rgba(236, 72, 153, 0.7)',
                      'rgba(251, 146, 60, 0.7)',
                      'rgba(34, 197, 94, 0.7)',
                      'rgba(59, 130, 246, 0.7)'
                    ]
                  }]
                },
                options: {
                  responsive: true
                }
              })
            }

            // ====== GRÁFICO: ESTUDOS ÚLTIMOS 7 DIAS ======
            const ctxEstudos = document.getElementById('chartEstudos7Dias')
            if (chartEstudos7Dias) chartEstudos7Dias.destroy()

            if (data.estudos_ultimos_7_dias && data.estudos_ultimos_7_dias.length > 0) {
              chartEstudos7Dias = new Chart(ctxEstudos, {
                type: 'bar',
                data: {
                  labels: data.estudos_ultimos_7_dias.map(e => {
                    const d = new Date(e.data_estudo)
                    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
                  }),
                  datasets: [{
                    label: 'Estudos',
                    data: data.estudos_ultimos_7_dias.map(e => e.total),
                    backgroundColor: 'rgba(34, 197, 94, 0.7)',
                    borderColor: 'rgba(34, 197, 94, 1)',
                    borderWidth: 2
                  }]
                },
                options: {
                  responsive: true,
                  scales: {
                    y: { beginAtZero: true }
                  }
                }
              })
            }

            // ====== GRÁFICO: PERFORMANCE POR PREVALÊNCIA ======
            const ctxPrevalencia = document.getElementById('chartPrevalencia')
            if (chartPrevalencia) chartPrevalencia.destroy()

            if (data.performance_por_prevalencia && data.performance_por_prevalencia.length > 0) {
              chartPrevalencia = new Chart(ctxPrevalencia, {
                type: 'bar',
                data: {
                  labels: data.performance_por_prevalencia.map(p => p.prevalencia),
                  datasets: [{
                    label: 'Acurácia Média (%)',
                    data: data.performance_por_prevalencia.map(p => p.media_acuracia),
                    backgroundColor: 'rgba(251, 146, 60, 0.7)',
                    borderColor: 'rgba(251, 146, 60, 1)',
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

            // ====== TEMAS DOMINADOS ======
            const dominadosDiv = document.getElementById('temas-dominados')
            if (data.temas_dominados && data.temas_dominados.length > 0) {
              dominadosDiv.innerHTML = data.temas_dominados.map(t => \`
                <div class="border border-green-200 rounded-lg p-3 bg-green-50">
                  <h4 class="font-semibold text-gray-800">\${t.tema}</h4>
                  <p class="text-sm text-gray-600">\${t.area} · <span class="text-green-600 font-bold">\${t.media_acuracia.toFixed(1)}%</span></p>
                  <p class="text-xs text-gray-500">Estudado \${t.vezes_estudado}x</p>
                </div>
              \`).join('')
            } else {
              dominadosDiv.innerHTML = '<p class="text-gray-600">Nenhum tema dominado ainda. Continue estudando! 💪</p>'
            }

            // ====== TEMAS MAIS ERRADOS ======
            const erradosDiv = document.getElementById('temas-errados')
            if (data.temas_mais_errados && data.temas_mais_errados.length > 0) {
              erradosDiv.innerHTML = data.temas_mais_errados.map(t => \`
                <div class="border border-red-200 rounded-lg p-3 bg-red-50">
                  <h4 class="font-semibold text-gray-800">\${t.tema}</h4>
                  <p class="text-sm text-gray-600">\${t.area} · <span class="text-red-600 font-bold">\${t.media_acuracia.toFixed(1)}%</span></p>
                  <p class="text-xs text-gray-500">Estudado \${t.vezes_estudado}x</p>
                </div>
              \`).join('')
            } else {
              erradosDiv.innerHTML = '<p class="text-gray-600">Nenhum tema com <70% de acurácia 🎉</p>'
            }

            // ====== TEMAS MAIS REVISADOS ======
            const revisadosDiv = document.getElementById('temas-revisados')
            if (data.temas_mais_revisados && data.temas_mais_revisados.length > 0) {
              revisadosDiv.innerHTML = data.temas_mais_revisados.map(t => \`
                <div class="border border-purple-200 rounded-lg p-3 bg-purple-50">
                  <h4 class="font-semibold text-gray-800">\${t.tema}</h4>
                  <p class="text-sm text-gray-600">\${t.area}</p>
                  <p class="text-xs text-purple-600 font-bold">\${t.total_revisoes} revisões</p>
                </div>
              \`).join('')
            } else {
              revisadosDiv.innerHTML = '<p class="text-gray-600">Nenhuma revisão realizada ainda.</p>'
            }

            // ====== RESUMO DO PROGRESSO ======
            document.getElementById('resumo-semanas').textContent = \`--/\${data.total_semanas_ciclo || 40}\`
            document.getElementById('resumo-temas').textContent = \`\${data.temas_estudados || 0}/\${data.temas_totais_ciclo || 0}\`
            document.getElementById('resumo-media-dia').textContent = (data.media_questoes_dia || 0).toFixed(1)
            document.getElementById('resumo-atrasadas').textContent = data.revisoes_atrasadas || 0

            // ====== META DE QUESTÕES ENARE 2026 ======
            if (data.meta_questoes) {
              const meta = data.meta_questoes
              
              // Números principais
              document.getElementById('meta-questoes-total').textContent = meta.total_questoes.toLocaleString('pt-BR')
              document.getElementById('meta-percentual').textContent = meta.percentual_meta.toFixed(1) + '%'
              document.getElementById('meta-barra').style.width = Math.min(meta.percentual_meta, 100) + '%'
              
              // Próximo checkpoint
              if (meta.proximo_checkpoint) {
                document.getElementById('meta-proximo-checkpoint').textContent = meta.proximo_checkpoint.trimestre
                document.getElementById('meta-checkpoint-progresso').textContent = meta.percentual_checkpoint.toFixed(1) + '% do checkpoint'
              }
              
              // Ritmos
              document.getElementById('meta-ritmo-atual').textContent = meta.ritmo_atual.toFixed(1)
              document.getElementById('meta-ritmo-necessario').textContent = meta.ritmo_necessario.toFixed(1)
              
              // Status e projeção
              const statusTexto = meta.no_caminho_certo 
                ? \`✅ No caminho certo! Faltam \${meta.questoes_faltam.toLocaleString('pt-BR')} questões\`
                : \`⚠️ Precisa acelerar! Faltam \${meta.questoes_faltam.toLocaleString('pt-BR')} questões\`
              
              document.getElementById('meta-status').textContent = statusTexto
              document.getElementById('meta-status-icon').className = meta.no_caminho_certo 
                ? 'fas fa-check-circle text-3xl opacity-70' 
                : 'fas fa-exclamation-triangle text-3xl opacity-70'
              
              document.getElementById('meta-projecao').textContent = \`\${meta.projecao_final.toLocaleString('pt-BR')} questões\`
              document.getElementById('meta-projecao-icon').className = meta.no_caminho_certo
                ? 'fas fa-rocket text-3xl opacity-70'
                : 'fas fa-hourglass-half text-3xl opacity-70'
              
              // Gráfico de checkpoints
              const ctxCheckpoints = document.getElementById('chartCheckpoints')
              if (chartCheckpoints) {
                new Chart(ctxCheckpoints, {
                  type: 'line',
                  data: {
                    labels: meta.checkpoints.map(c => c.trimestre),
                    datasets: [
                      {
                        label: 'Meta',
                        data: meta.checkpoints.map(c => c.meta),
                        borderColor: 'rgba(99, 102, 241, 1)',
                        backgroundColor: 'rgba(99, 102, 241, 0.1)',
                        borderWidth: 3,
                        tension: 0.4,
                        fill: false
                      },
                      {
                        label: 'Seu Progresso',
                        data: meta.checkpoints.map(c => {
                          const checkDate = new Date(c.data)
                          const hoje = new Date()
                          return hoje > checkDate ? meta.total_questoes : null
                        }),
                        borderColor: 'rgba(34, 197, 94, 1)',
                        backgroundColor: 'rgba(34, 197, 94, 0.1)',
                        borderWidth: 3,
                        tension: 0,
                        fill: false,
                        spanGaps: false
                      },
                      {
                        label: 'Projeção',
                        data: meta.checkpoints.map((c, i) => {
                          if (i === meta.checkpoints.length - 1) {
                            return meta.projecao_final
                          }
                          return null
                        }),
                        borderColor: 'rgba(251, 146, 60, 1)',
                        backgroundColor: 'rgba(251, 146, 60, 0.1)',
                        borderWidth: 2,
                        borderDash: [5, 5],
                        tension: 0,
                        fill: false,
                        spanGaps: true,
                        pointRadius: 8,
                        pointStyle: 'star'
                      }
                    ]
                  },
                  options: {
                    responsive: true,
                    scales: {
                      y: {
                        beginAtZero: true,
                        max: 16000,
                        ticks: {
                          callback: function(value) {
                            return value.toLocaleString('pt-BR')
                          }
                        }
                      }
                    },
                    plugins: {
                      tooltip: {
                        callbacks: {
                          label: function(context) {
                            return context.dataset.label + ': ' + (context.parsed.y || 0).toLocaleString('pt-BR') + ' questões'
                          }
                        }
                      }
                    }
                  }
                })
              }
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
