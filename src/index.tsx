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
// API: DASHBOARD COMPLETO (UNIFIED - 1 REQUEST ONLY!)
// ====================================================
app.get('/api/dashboard-completo', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const usuarioId = auth.usuario.usuario_id
  
  try {
    const hoje = getDataISOBrasil()

    // Buscar semana atual da configuração
    const config = await DB.prepare('SELECT semana_atual FROM configuracoes WHERE usuario_id = ?')
      .bind(usuarioId).first()
    const semanaAtual = config?.semana_atual || 1

    // Executar TUDO em paralelo com batch (super rápido!)
    const [semanaData, temasData, revisoesData, metricasBasicas, metricasRevisoes] = await Promise.all([
      // 1. Dados da semana
      DB.prepare('SELECT * FROM semanas WHERE numero_semana = ? AND usuario_id = ?')
        .bind(semanaAtual, usuarioId).first(),
      
      // 2. Temas da semana (com status de estudado)
      DB.prepare(`
        SELECT st.*, t.*, 
          (SELECT COUNT(*) FROM estudos e WHERE e.tema_id = t.id AND e.usuario_id = ?) as ja_estudado
        FROM semana_temas st
        INNER JOIN temas t ON st.tema_id = t.id
        INNER JOIN semanas s ON st.semana_id = s.id
        WHERE s.numero_semana = ? AND s.usuario_id = ?
        ORDER BY st.ordem
      `).bind(usuarioId, semanaAtual, usuarioId).all(),
      
      // 3. Revisões pendentes (limitado a 20)
      DB.prepare(`
        SELECT r.*, t.tema, t.area, t.prevalencia, t.prevalencia_numero
        FROM revisoes r
        INNER JOIN temas t ON r.tema_id = t.id
        INNER JOIN estudos e ON r.estudo_id = e.id
        WHERE r.concluida = 0 AND e.usuario_id = ?
        ORDER BY r.data_agendada ASC, t.prevalencia_numero DESC
        LIMIT 20
      `).bind(usuarioId).all(),
      
      // 4. Métricas básicas (combinadas)
      DB.prepare(`
        SELECT 
          COUNT(*) as total_estudos,
          COALESCE(SUM(questoes_feitas), 0) as total_questoes,
          COALESCE(SUM(tempo_minutos), 0) as tempo_total_minutos,
          COALESCE(AVG(CASE WHEN acuracia > 0 THEN acuracia ELSE NULL END), 0) as acuracia_media
        FROM estudos WHERE usuario_id = ?
      `).bind(usuarioId).first(),
      
      // 5. Métricas de revisões (combinadas)
      DB.prepare(`
        SELECT 
          COUNT(CASE WHEN r.concluida = 0 AND r.data_agendada <= ? THEN 1 END) as pendentes
        FROM revisoes r
        INNER JOIN estudos e ON r.estudo_id = e.id
        WHERE e.usuario_id = ?
      `).bind(hoje, usuarioId).first()
    ])

    return c.json({
      semana: {
        numero_semana: semanaAtual,
        ...semanaData
      },
      temas: temasData.results || [],
      revisoes: revisoesData.results || [],
      metricas: {
        total_estudos: metricasBasicas?.total_estudos || 0,
        total_questoes: metricasBasicas?.total_questoes || 0,
        acuracia_media: metricasBasicas?.acuracia_media || 0,
        revisoes_pendentes: metricasRevisoes?.pendentes || 0
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
// FRONTEND: ROTA RAIZ (REDIRECIONA PARA HOME)
// ====================================================
app.get('/', (c) => {
  return c.redirect('/home')
})

// ====================================================
// FRONTEND: DASHBOARD (PROTEGIDA)
// ====================================================
app.get('/dashboard', async (c) => {
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
        <title>Home - ${nomeUsuario}</title>
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
        <header style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);" class="shadow-2xl">
            <div class="max-w-7xl mx-auto px-6 py-6">
                <!-- Top Row: Logo + Actions -->
                <div class="flex items-center justify-between mb-4">
                    <!-- Logo e Título (Compacto) -->
                    <div class="flex items-center space-x-3">
                        <div class="bg-white bg-opacity-20 backdrop-blur-sm p-3 rounded-xl">
                            <i class="fas fa-brain text-white text-3xl"></i>
                        </div>
                        <div>
                            <h1 class="text-2xl font-bold text-white">HardMed</h1>
                            <p class="text-white text-opacity-80 text-sm">ENARE 2026</p>
                        </div>
                    </div>
                    
                    <!-- Actions: Admin + Theme + User -->
                    <div class="flex items-center space-x-3">
                        <!-- Botão Admin (condicional) -->
                        ${auth.usuario.is_admin ? `
                        <a href="/admin" 
                           class="bg-white bg-opacity-20 backdrop-blur-sm hover:bg-opacity-30 px-4 py-2 rounded-lg transition text-white font-semibold text-sm border border-white border-opacity-30">
                            <i class="fas fa-shield-alt mr-2"></i>Admin
                        </a>
                        ` : ''}
                        
                        <!-- Botão Theme -->
                        <button onclick="toggleTheme()" 
                                class="bg-white bg-opacity-20 backdrop-blur-sm hover:bg-opacity-30 p-3 rounded-lg transition border border-white border-opacity-30" 
                                title="Alternar tema">
                            <i id="theme-icon" class="fas fa-moon text-white"></i>
                        </button>
                        
                        <!-- User Menu -->
                        <div class="bg-white bg-opacity-20 backdrop-blur-sm rounded-lg px-4 py-2 border border-white border-opacity-30">
                            <div class="flex items-center space-x-3">
                                <div class="text-right">
                                    <p class="text-white text-sm font-semibold">${nomeUsuario}</p>
                                    <p class="text-white text-opacity-70 text-xs">Semana <span id="semana-atual">--</span></p>
                                </div>
                                <button onclick="logout()" 
                                        class="bg-white bg-opacity-20 hover:bg-opacity-30 p-2 rounded-lg transition"
                                        title="Sair">
                                    <i class="fas fa-sign-out-alt text-white"></i>
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
                    <i class="fas fa-calendar-alt mr-2"></i>Ciclo de Estudos
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
                <!-- Alerta do Ciclo Atual -->
                <div id="alerta-ciclo" class="hidden mb-6"></div>

                <!-- Seleção de Tipo de Ciclo -->
                <div id="selecao-ciclo" class="mb-6">
                    <div class="bg-gradient-to-r from-indigo-600 to-purple-600 rounded-xl shadow-lg p-8 text-white mb-6">
                        <h2 class="text-3xl font-bold mb-2">🧠 Ciclo de Estudos Adaptativo</h2>
                        <p class="text-indigo-100">Escolha o tipo de ciclo ideal baseado no seu tempo disponível até a prova</p>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <!-- Extensivo -->
                        <div class="bg-white rounded-xl shadow-lg overflow-hidden hover:shadow-2xl transition-all duration-300 border-2 border-transparent hover:border-indigo-500">
                            <div class="bg-gradient-to-br from-blue-500 to-blue-600 p-6 text-white">
                                <div class="flex items-center justify-between mb-3">
                                    <h3 class="text-2xl font-bold">📘 Extensivo</h3>
                                    <div class="bg-white text-blue-600 px-3 py-1 rounded-full text-sm font-semibold">40 semanas</div>
                                </div>
                                <p class="text-blue-100">Cobertura completa e aprofundada</p>
                            </div>
                            <div class="p-6">
                                <div class="space-y-3 mb-6">
                                    <div class="flex items-start">
                                        <i class="fas fa-check-circle text-green-500 mt-1 mr-3"></i>
                                        <span class="text-gray-700">Todos os 419 temas</span>
                                    </div>
                                    <div class="flex items-start">
                                        <i class="fas fa-check-circle text-green-500 mt-1 mr-3"></i>
                                        <span class="text-gray-700">Alta + Média + Baixa prevalência</span>
                                    </div>
                                    <div class="flex items-start">
                                        <i class="fas fa-check-circle text-green-500 mt-1 mr-3"></i>
                                        <span class="text-gray-700">Ritmo tranquilo (~10 temas/semana)</span>
                                    </div>
                                    <div class="flex items-start">
                                        <i class="fas fa-calendar-alt text-indigo-500 mt-1 mr-3"></i>
                                        <span class="text-gray-600 font-semibold">Recomendado: > 9 meses</span>
                                    </div>
                                </div>
                                <button onclick="gerarCicloAdaptativo('extensivo')" 
                                    class="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-lg font-semibold transition">
                                    <i class="fas fa-rocket mr-2"></i>Gerar Ciclo Extensivo
                                </button>
                            </div>
                        </div>

                        <!-- Semi-intensivo -->
                        <div class="bg-white rounded-xl shadow-lg overflow-hidden hover:shadow-2xl transition-all duration-300 border-2 border-transparent hover:border-purple-500">
                            <div class="bg-gradient-to-br from-purple-500 to-purple-600 p-6 text-white">
                                <div class="flex items-center justify-between mb-3">
                                    <h3 class="text-2xl font-bold">📗 Semi-intensivo</h3>
                                    <div class="bg-white text-purple-600 px-3 py-1 rounded-full text-sm font-semibold">20 semanas</div>
                                </div>
                                <p class="text-purple-100">Equilíbrio entre cobertura e intensidade</p>
                            </div>
                            <div class="p-6">
                                <div class="space-y-3 mb-6">
                                    <div class="flex items-start">
                                        <i class="fas fa-check-circle text-green-500 mt-1 mr-3"></i>
                                        <span class="text-gray-700">Alta + Média prevalência</span>
                                    </div>
                                    <div class="flex items-start">
                                        <i class="fas fa-check-circle text-green-500 mt-1 mr-3"></i>
                                        <span class="text-gray-700">~285 temas essenciais</span>
                                    </div>
                                    <div class="flex items-start">
                                        <i class="fas fa-check-circle text-green-500 mt-1 mr-3"></i>
                                        <span class="text-gray-700">Ritmo moderado (~14 temas/semana)</span>
                                    </div>
                                    <div class="flex items-start">
                                        <i class="fas fa-calendar-alt text-indigo-500 mt-1 mr-3"></i>
                                        <span class="text-gray-600 font-semibold">Recomendado: 5-8 meses</span>
                                    </div>
                                </div>
                                <button onclick="gerarCicloAdaptativo('semi-intensivo')" 
                                    class="w-full bg-purple-600 hover:bg-purple-700 text-white py-3 rounded-lg font-semibold transition">
                                    <i class="fas fa-bolt mr-2"></i>Gerar Ciclo Semi-intensivo
                                </button>
                            </div>
                        </div>

                        <!-- Intensivo -->
                        <div class="bg-white rounded-xl shadow-lg overflow-hidden hover:shadow-2xl transition-all duration-300 border-2 border-transparent hover:border-red-500">
                            <div class="bg-gradient-to-br from-red-500 to-red-600 p-6 text-white">
                                <div class="flex items-center justify-between mb-3">
                                    <h3 class="text-2xl font-bold">🔥 Intensivo</h3>
                                    <div class="bg-white text-red-600 px-3 py-1 rounded-full text-sm font-semibold">10 semanas</div>
                                </div>
                                <p class="text-red-100">Foco máximo no essencial</p>
                            </div>
                            <div class="p-6">
                                <div class="space-y-3 mb-6">
                                    <div class="flex items-start">
                                        <i class="fas fa-fire text-red-500 mt-1 mr-3"></i>
                                        <span class="text-gray-700">Alta prevalência prioritária</span>
                                    </div>
                                    <div class="flex items-start">
                                        <i class="fas fa-fire text-red-500 mt-1 mr-3"></i>
                                        <span class="text-gray-700">~150+ temas críticos</span>
                                    </div>
                                    <div class="flex items-start">
                                        <i class="fas fa-fire text-red-500 mt-1 mr-3"></i>
                                        <span class="text-gray-700">Ritmo acelerado (~15 temas/semana)</span>
                                    </div>
                                    <div class="flex items-start">
                                        <i class="fas fa-calendar-alt text-indigo-500 mt-1 mr-3"></i>
                                        <span class="text-gray-600 font-semibold">Recomendado: < 5 meses</span>
                                    </div>
                                </div>
                                <button onclick="gerarCicloAdaptativo('intensivo')" 
                                    class="w-full bg-red-600 hover:bg-red-700 text-white py-3 rounded-lg font-semibold transition">
                                    <i class="fas fa-fire mr-2"></i>Gerar Ciclo Intensivo
                                </button>
                            </div>
                        </div>
                    </div>

                    <div class="mt-6 bg-blue-50 border-l-4 border-blue-500 p-4 rounded">
                        <div class="flex items-start">
                            <i class="fas fa-info-circle text-blue-500 text-xl mr-3 mt-1"></i>
                            <div>
                                <p class="text-blue-900 font-semibold mb-1">💡 Como funciona a adaptação automática?</p>
                                <p class="text-blue-800 text-sm">O sistema calcula automaticamente as semanas disponíveis até sua data da prova e adapta o ciclo escolhido. Se você tiver menos tempo que o padrão, a engine redistribui os temas de forma inteligente!</p>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Visualização do Ciclo Atual -->
                <div id="visualizacao-ciclo" class="hidden">
                    <!-- Estatísticas do Ciclo -->
                    <div class="bg-white rounded-xl shadow-lg p-6 mb-6">
                        <div class="flex items-center justify-between mb-4">
                            <h2 class="text-2xl font-bold text-gray-800">
                                <i class="fas fa-chart-line text-indigo-600 mr-2"></i>
                                Seu Ciclo Atual
                            </h2>
                            <div class="space-x-2">
                                <button onclick="pausarCiclo()" class="bg-yellow-500 hover:bg-yellow-600 text-white px-4 py-2 rounded-lg text-sm font-semibold">
                                    <i class="fas fa-pause mr-1"></i>Pausar
                                </button>
                                <button onclick="cancelarCiclo()" class="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-semibold">
                                    <i class="fas fa-times mr-1"></i>Cancelar
                                </button>
                                <button onclick="mostrarSelecaoCiclo()" class="bg-indigo-500 hover:bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-semibold">
                                    <i class="fas fa-redo mr-1"></i>Novo Ciclo
                                </button>
                            </div>
                        </div>
                        
                        <div id="stats-ciclo" class="grid grid-cols-2 md:grid-cols-5 gap-4">
                            <!-- Stats dinâmicos -->
                        </div>
                    </div>

                    <!-- Linha do Tempo -->
                    <div class="bg-white rounded-xl shadow-lg p-6">
                        <h2 class="text-2xl font-bold text-gray-800 mb-4">
                            <i class="fas fa-calendar-alt text-indigo-600 mr-2"></i>
                            Linha do Tempo
                        </h2>
                        <div id="linha-tempo-semanas" class="grid grid-cols-1 md:grid-cols-4 gap-4">
                            <!-- Semanas dinâmicas -->
                        </div>
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

            if (tabName === 'ciclo') carregarCicloAtual()
            if (tabName === 'revisoes') loadRevisoes()
            if (tabName === 'metricas') loadMetricas()
        }

        // Dashboard
        async function loadDashboard() {
          try {
            // OTIMIZAÇÃO: Uma única chamada API em vez de 3!
            const dashboardRes = await fetch('/api/dashboard-completo')
            const data = await dashboardRes.json()
            
            // Atualizar semana atual
            document.getElementById('semana-atual').textContent = data.semana?.numero_semana || '--'

            // Renderizar guia do dia
            const guiaDiv = document.getElementById('guia-do-dia')
            if (data.temas && data.temas.length > 0) {
              guiaDiv.innerHTML = data.temas.map(t => \`
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

            // Renderizar revisões pendentes
            const revisoesDiv = document.getElementById('revisoes-do-dia')
            if (data.revisoes && data.revisoes.length > 0) {
              const hoje = getDataHojeBrasil()
              
              revisoesDiv.innerHTML = data.revisoes.slice(0, 5).map(r => {
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

            // Atualizar quick stats
            const stats = document.querySelectorAll('#quick-stats .text-3xl')
            stats[0].textContent = data.metricas.total_estudos || 0
            stats[1].textContent = data.metricas.total_questoes || 0
            stats[2].textContent = data.metricas.acuracia_media ? data.metricas.acuracia_media.toFixed(1) + '%' : '--'
            stats[3].textContent = data.metricas.revisoes_pendentes || 0

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

        // ====================================================
        // FUNÇÕES DO CICLO ADAPTATIVO
        // ====================================================

        // Gerar ciclo adaptativo
        async function gerarCicloAdaptativo(tipoCiclo) {
          const tiposNome = {
            'extensivo': 'Extensivo (40 semanas)',
            'semi-intensivo': 'Semi-intensivo (20 semanas)',
            'intensivo': 'Intensivo (10 semanas)'
          }

          Modal.confirm(
            'Gerar Ciclo ' + tiposNome[tipoCiclo], 
            'O sistema calculará automaticamente as semanas disponíveis até sua prova e adaptará o ciclo conforme necessário. Deseja continuar?',
            async () => {
              try {
                const res = await fetch('/api/ciclo/gerar', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ tipo_ciclo: tipoCiclo })
                })
                const data = await res.json()
                
                if (data.success) {
                  // Mostrar alerta de sucesso com estatísticas
                  const mensagemHTML = '<div class="text-left space-y-2">' +
                    '<p class="font-semibold text-lg text-indigo-600">' + data.mensagem + '</p>' +
                    '<div class="bg-gray-50 p-4 rounded-lg mt-3">' +
                    '<p class="text-sm"><strong>Tipo:</strong> ' + data.estatisticas.tipo_ciclo + '</p>' +
                    '<p class="text-sm"><strong>Semanas:</strong> ' + data.estatisticas.semanas_reais + '</p>' +
                    '<p class="text-sm"><strong>Total de temas:</strong> ' + data.estatisticas.total_temas + '</p>' +
                    '<p class="text-sm"><strong>Alta prevalência:</strong> ' + data.estatisticas.temas_alta + '</p>' +
                    '<p class="text-sm"><strong>Média prevalência:</strong> ' + data.estatisticas.temas_media + '</p>' +
                    '<p class="text-sm"><strong>Baixa prevalência:</strong> ' + data.estatisticas.temas_baixa + '</p>' +
                    '<p class="text-sm"><strong>Temas por semana:</strong> ~' + data.estatisticas.temas_por_semana + '</p>' +
                    '</div></div>'
                  await Modal.alert('Ciclo Gerado com Sucesso! 🎉', mensagemHTML, 'success')
                  
                  // Atualizar visualização
                  await carregarCicloAtual()
                  loadDashboard()
                } else {
                  await Modal.alert('Erro', data.error, 'error')
                }
              } catch (error) {
                console.error('Erro ao gerar ciclo:', error)
                await Modal.alert('Erro', 'Erro ao gerar ciclo adaptativo', 'error')
              }
            }
          )
        }

        // Carregar ciclo atual
        async function carregarCicloAtual() {
          try {
            const res = await fetch('/api/ciclo')
            const data = await res.json()
            
            const selecaoDiv = document.getElementById('selecao-ciclo')
            const visualizacaoDiv = document.getElementById('visualizacao-ciclo')
            const alertaDiv = document.getElementById('alerta-ciclo')

            if (data.ciclo) {
              // Mostrar visualização do ciclo
              selecaoDiv.classList.add('hidden')
              visualizacaoDiv.classList.remove('hidden')

              // Mostrar alerta se existir
              if (data.ciclo.mensagem_alerta) {
                alertaDiv.classList.remove('hidden')
                
                let bgAlert, borderAlert, textAlert, iconAlert
                if (data.ciclo.semanas_reais < 10) {
                  bgAlert = 'bg-red-50'
                  borderAlert = 'border-red-500'
                  textAlert = 'text-red-900'
                  iconAlert = 'text-red-500'
                } else if (data.ciclo.semanas_reais < 20) {
                  bgAlert = 'bg-yellow-50'
                  borderAlert = 'border-yellow-500'
                  textAlert = 'text-yellow-900'
                  iconAlert = 'text-yellow-500'
                } else {
                  bgAlert = 'bg-blue-50'
                  borderAlert = 'border-blue-500'
                  textAlert = 'text-blue-900'
                  iconAlert = 'text-blue-500'
                }
                
                alertaDiv.innerHTML = '<div class="' + bgAlert + ' border-l-4 ' + borderAlert + ' p-4 rounded">' +
                  '<div class="flex items-start">' +
                    '<i class="fas fa-info-circle ' + iconAlert + ' text-xl mr-3 mt-1"></i>' +
                    '<div><p class="' + textAlert + ' font-semibold">' + data.ciclo.mensagem_alerta + '</p></div>' +
                  '</div>' +
                '</div>'
              }

              // Renderizar estatísticas
              const statsDiv = document.getElementById('stats-ciclo')
              const tipoCicloNome = {
                'extensivo': 'Extensivo',
                'semi-intensivo': 'Semi-intensivo',
                'intensivo': 'Intensivo'
              }
              
              const totalTemas = data.ciclo.temas_alta + data.ciclo.temas_media + data.ciclo.temas_baixa
              const statusEmoji = data.ciclo.status === 'ativo' ? '✅ Ativo' : data.ciclo.status === 'pausado' ? '⏸️ Pausado' : '❌ Cancelado'

              statsDiv.innerHTML = '<div class="bg-indigo-50 p-4 rounded-lg">' +
                '<p class="text-xs text-indigo-600 font-semibold uppercase">Tipo</p>' +
                '<p class="text-2xl font-bold text-indigo-600">' + tipoCicloNome[data.ciclo.tipo_ciclo] + '</p>' +
              '</div>' +
              '<div class="bg-blue-50 p-4 rounded-lg">' +
                '<p class="text-xs text-blue-600 font-semibold uppercase">Semanas</p>' +
                '<p class="text-2xl font-bold text-blue-600">' + data.ciclo.semanas_reais + '</p>' +
              '</div>' +
              '<div class="bg-green-50 p-4 rounded-lg">' +
                '<p class="text-xs text-green-600 font-semibold uppercase">Total Temas</p>' +
                '<p class="text-2xl font-bold text-green-600">' + totalTemas + '</p>' +
              '</div>' +
              '<div class="bg-purple-50 p-4 rounded-lg">' +
                '<p class="text-xs text-purple-600 font-semibold uppercase">Progresso</p>' +
                '<p class="text-2xl font-bold text-purple-600">' + data.ciclo.progresso_atual + '%</p>' +
              '</div>' +
              '<div class="bg-orange-50 p-4 rounded-lg">' +
                '<p class="text-xs text-orange-600 font-semibold uppercase">Status</p>' +
                '<p class="text-lg font-bold text-orange-600">' + statusEmoji + '</p>' +
              '</div>'

              // Renderizar semanas
              renderizarLinhaDoTempo(data.semanas)
            } else {
              // Mostrar seleção de ciclo
              selecaoDiv.classList.remove('hidden')
              visualizacaoDiv.classList.add('hidden')
              alertaDiv.classList.add('hidden')
            }
          } catch (error) {
            console.error('Erro ao carregar ciclo:', error)
          }
        }

        // Renderizar linha do tempo
        function renderizarLinhaDoTempo(semanas) {
          const linhaTempoDiv = document.getElementById('linha-tempo-semanas')
          
          if (semanas && semanas.length > 0) {
            linhaTempoDiv.innerHTML = semanas.map(s => {
              let borderClass, bgClass, iconClass, barClass, iconName
              
              if (s.status === 'concluida') {
                borderClass = 'border-green-300'
                bgClass = 'bg-green-50'
                iconClass = 'text-green-500'
                barClass = 'bg-green-500'
                iconName = 'fa-check-circle'
              } else if (s.status === 'em_andamento') {
                borderClass = 'border-yellow-300'
                bgClass = 'bg-yellow-50'
                iconClass = 'text-yellow-500'
                barClass = 'bg-yellow-500'
                iconName = 'fa-spinner'
              } else {
                borderClass = 'border-gray-200'
                bgClass = 'bg-white'
                iconClass = 'text-gray-400'
                barClass = 'bg-gray-400'
                iconName = 'fa-circle'
              }
              
              const progresso = (s.temas_concluidos / s.temas_planejados * 100) || 0
              const dataInicio = new Date(s.data_inicio).toLocaleDateString('pt-BR')
              const dataFim = new Date(s.data_fim).toLocaleDateString('pt-BR')
              
              return '<div class="border-2 ' + borderClass + ' rounded-lg p-4 hover:shadow-lg transition cursor-pointer ' + bgClass + '" ' +
                     'onclick="verTemasDoNovoCiclo(' + s.id + ', ' + s.numero_semana + ')">' +
                '<div class="flex items-center justify-between mb-2">' +
                  '<h3 class="font-bold text-gray-800">Semana ' + s.numero_semana + '</h3>' +
                  '<i class="fas ' + iconName + ' ' + iconClass + '"></i>' +
                '</div>' +
                '<p class="text-xs text-gray-600 mb-2">' + dataInicio + ' - ' + dataFim + '</p>' +
                '<div class="space-y-1">' +
                  '<p class="text-sm text-gray-700">' + s.temas_planejados + ' temas</p>' +
                  '<div class="w-full bg-gray-200 rounded-full h-2">' +
                    '<div class="' + barClass + ' h-2 rounded-full" style="width: ' + progresso + '%"></div>' +
                  '</div>' +
                  '<p class="text-xs text-gray-500">' + s.temas_concluidos + '/' + s.temas_planejados + ' concluídos</p>' +
                '</div>' +
                '<p class="text-xs text-indigo-600 mt-2"><i class="fas fa-eye mr-1"></i>Ver temas</p>' +
              '</div>'
            }).join('')
          } else {
            linhaTempoDiv.innerHTML = '<p class="text-gray-600 col-span-4">Nenhuma semana no ciclo.</p>'
          }
        }

        // Ver temas de uma semana do novo ciclo
        async function verTemasDoNovoCiclo(semanaId, numeroSemana) {
          try {
            const res = await fetch('/api/ciclo')
            const data = await res.json()
            
            const semana = data.semanas.find(s => s.id === semanaId)
            if (!semana || !semana.temas || semana.temas.length === 0) {
              await Modal.alert('Sem Temas', 'Esta semana não possui temas.', 'info')
              return
            }

            const temasHTML = semana.temas.map(t => {
              let prevClass = ''
              if (t.prevalencia === 'ALTA') {
                prevClass = 'bg-red-100 text-red-700'
              } else if (t.prevalencia === 'MÉDIA') {
                prevClass = 'bg-yellow-100 text-yellow-700'
              } else {
                prevClass = 'bg-green-100 text-green-700'
              }
              
              const statusIcon = t.status === 'concluido' ? 'text-green-500' : 'text-gray-300'
              const statusText = t.status === 'concluido' ? 'Concluído' : t.status === 'em_andamento' ? 'Em andamento' : 'Pendente'
              
              return '<div class="border border-gray-200 rounded-lg p-3 hover:bg-gray-50">' +
                '<div class="flex items-start justify-between">' +
                  '<div class="flex-1">' +
                    '<h4 class="font-semibold text-gray-800">' + t.tema + '</h4>' +
                    '<p class="text-sm text-gray-600 mt-1">' +
                      '<i class="fas fa-folder mr-1"></i>' + t.area + ' · ' + t.subarea +
                    '</p>' +
                    '<p class="text-xs text-gray-500 mt-1">' + (t.subtopicos || '') + '</p>' +
                    '<div class="flex items-center mt-2 space-x-3">' +
                      '<span class="text-xs px-2 py-1 rounded ' + prevClass + '">' + t.prevalencia + '</span>' +
                      '<span class="text-xs text-gray-600">' +
                        '<i class="fas fa-check-circle ' + statusIcon + ' mr-1"></i>' + statusText +
                      '</span>' +
                    '</div>' +
                  '</div>' +
                '</div>' +
              '</div>'
            }).join('')
            
            Modal.show({
              title: 'Semana ' + numeroSemana + ' - ' + semana.temas.length + ' Temas',
              content: '<div class="max-h-96 overflow-y-auto space-y-3">' + temasHTML + '</div>',
              type: 'info',
              buttons: [
                { label: 'Fechar', primary: true, callback: () => {} }
              ]
            })
          } catch (error) {
            console.error('Erro ao carregar temas:', error)
            await Modal.alert('Erro', 'Erro ao carregar temas da semana', 'error')
          }
        }

        // Pausar ciclo
        async function pausarCiclo() {
          Modal.confirm(
            'Pausar Ciclo',
            'Você poderá reativar o ciclo depois. Tem certeza?',
            async () => {
              try {
                const res = await fetch('/api/ciclo/pausar', { method: 'POST' })
                const data = await res.json()
                
                if (data.success) {
                  await Modal.alert('Sucesso', 'Ciclo pausado com sucesso!', 'success')
                  await carregarCicloAtual()
                } else {
                  await Modal.alert('Erro', data.error, 'error')
                }
              } catch (error) {
                await Modal.alert('Erro', 'Erro ao pausar ciclo', 'error')
              }
            }
          )
        }

        // Cancelar ciclo
        async function cancelarCiclo() {
          Modal.confirm(
            'Cancelar Ciclo',
            'Esta ação NÃO pode ser desfeita! Você perderá todo o progresso. Tem certeza?',
            async () => {
              try {
                const res = await fetch('/api/ciclo/cancelar', { method: 'POST' })
                const data = await res.json()
                
                if (data.success) {
                  await Modal.alert('Ciclo Cancelado', 'Você pode gerar um novo ciclo agora.', 'info')
                  await carregarCicloAtual()
                } else {
                  await Modal.alert('Erro', data.error, 'error')
                }
              } catch (error) {
                await Modal.alert('Erro', 'Erro ao cancelar ciclo', 'error')
              }
            }
          )
        }

        // Mostrar seleção de ciclo
        function mostrarSelecaoCiclo() {
          Modal.confirm(
            'Gerar Novo Ciclo',
            'Isso cancelará o ciclo atual. Deseja continuar?',
            async () => {
              await cancelarCiclo()
            }
          )
        }

        // ====================================================
        // FIM FUNÇÕES DO CICLO ADAPTATIVO
        // ====================================================

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

        <!-- Footer -->
        <footer class="text-center py-6 mt-12 text-gray-600 dark:text-gray-400 text-sm">
            <p>Criado com muito <span class="text-red-500">❤️</span> por <strong>Erique Melo</strong> e muito ☕</p>
        </footer>
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
    SELECT s.id as sessao_id, s.token, s.expires_at, 
           u.id as usuario_id, u.email, u.nome, u.data_prova, u.is_admin
    FROM sessoes s
    INNER JOIN usuarios u ON s.usuario_id = u.id
    WHERE s.token = ? AND s.expires_at > ?
  `).bind(token, hoje).first()

  if (!sessao) {
    return { error: 'Sessão expirada', status: 401 }
  }

  return { usuario: sessao }
}

// Middleware para verificar se é administrador
async function requireAdmin(c: any) {
  const auth = await requireAuth(c)
  if (auth.error) return auth
  
  if (!auth.usuario.is_admin) {
    return { error: 'Acesso negado: apenas administradores', status: 403 }
  }
  
  return auth
}

// API: Registro
app.post('/api/auth/registro', async (c) => {
  const { DB } = c.env
  
  try {
    const { email, senha, nome, data_prova } = await c.req.json()

    if (!email || !senha || !nome || !data_prova) {
      return c.json({ error: 'Email, senha, nome e data da prova são obrigatórios' }, 400)
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
    `).bind(email, senhaHash, nome, data_prova).run()

    const usuarioId = result.meta.last_row_id

    // Criar configuração inicial
    await DB.prepare(`
      INSERT INTO configuracoes (usuario_id, horas_por_dia, temas_por_dia, data_prova, semana_atual, ciclo_gerado)
      VALUES (?, 4, 4, ?, 1, 0)
    `).bind(usuarioId, data_prova).run()

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
        <title>HardMed - Domine o ENARE 2026 com Método Comprovado</title>
        <meta name="description" content="Sistema completo de estudos para ENARE 2026. 419 temas, revisões inteligentes, 40 semanas de planejamento. Saia de 58 para 85+ questões!">
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
            @keyframes pulse-glow {
                0%, 100% { box-shadow: 0 0 20px rgba(102, 126, 234, 0.4); }
                50% { box-shadow: 0 0 40px rgba(102, 126, 234, 0.8); }
            }
            .pulse-glow { animation: pulse-glow 2s ease-in-out infinite; }
            .method-card { border-left: 4px solid #667eea; }
            .scroll-smooth { scroll-behavior: smooth; }
        </style>
    </head>
    <body class="bg-white scroll-smooth">
        <!-- Hero Section -->
        <div class="gradient-bg min-h-screen flex items-center justify-center px-4 relative overflow-hidden">
            <div class="absolute inset-0 opacity-10">
                <div class="absolute top-20 left-10 text-white text-9xl"><i class="fas fa-book-medical"></i></div>
                <div class="absolute bottom-20 right-10 text-white text-9xl"><i class="fas fa-stethoscope"></i></div>
                <div class="absolute top-1/2 left-1/4 text-white text-7xl"><i class="fas fa-heartbeat"></i></div>
            </div>
            <div class="max-w-6xl mx-auto text-center text-white fade-in-up relative z-10">
                <div class="mb-6">
                    <i class="fas fa-brain text-8xl mb-6 animate-pulse"></i>
                </div>
                <div class="inline-block bg-yellow-400 text-gray-900 px-4 py-2 rounded-full text-sm font-bold mb-4">
                    🎯 META: 58 → 85+ QUESTÕES CORRETAS
                </div>
                <h1 class="text-5xl md:text-7xl font-bold mb-6 leading-tight">
                    Do Caos ao <span class="text-yellow-300">Planejamento</span><br/>
                    Do Esquecimento à <span class="text-yellow-300">Memória</span>
                </h1>
                <p class="text-xl md:text-2xl mb-8 opacity-90 max-w-3xl mx-auto">
                    Sistema completo de estudos para R1: <strong>419 temas</strong>, <strong>40 semanas</strong> de ciclo 
                    e método comprovado para <strong>ENARE 2026</strong>
                </p>
                <div class="flex flex-col md:flex-row justify-center gap-4 mb-12">
                    <a href="/login?registro=true" class="bg-yellow-400 text-gray-900 px-10 py-5 rounded-xl font-bold text-xl hover:bg-yellow-300 transition shadow-2xl pulse-glow inline-flex items-center justify-center">
                        <i class="fas fa-rocket mr-2"></i>COMEÇAR AGORA - GRÁTIS
                    </a>
                    <a href="#video" class="bg-white bg-opacity-20 backdrop-blur-sm text-white px-10 py-5 rounded-xl font-bold text-xl hover:bg-opacity-30 transition shadow-xl inline-flex items-center justify-center border-2 border-white">
                        <i class="fas fa-play-circle mr-2"></i>Ver Como Funciona
                    </a>
                </div>
                <div class="grid grid-cols-3 gap-6 max-w-2xl mx-auto text-center">
                    <div>
                        <div class="text-4xl font-bold text-yellow-300">419</div>
                        <div class="text-sm opacity-80">Temas ENARE</div>
                    </div>
                    <div>
                        <div class="text-4xl font-bold text-yellow-300">40</div>
                        <div class="text-sm opacity-80">Semanas de Ciclo</div>
                    </div>
                    <div>
                        <div class="text-4xl font-bold text-yellow-300">15K</div>
                        <div class="text-sm opacity-80">Meta de Questões</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Prova Social -->
        <div class="py-12 px-4 bg-indigo-900 text-white">
            <div class="max-w-6xl mx-auto">
                <div class="text-center mb-8">
                    <h3 class="text-2xl font-bold mb-4">✨ Resultados Reais de Residentes</h3>
                    <p class="text-indigo-200">Sistema desenvolvido por quem já passou pelo processo</p>
                </div>
                <div class="grid md:grid-cols-3 gap-8 text-center">
                    <div class="bg-white bg-opacity-10 backdrop-blur-sm rounded-xl p-6">
                        <div class="text-5xl font-bold text-yellow-300 mb-2">+27</div>
                        <div class="text-indigo-200">Questões a mais</div>
                        <div class="text-xs mt-2 text-indigo-300">ENARE 2024 → 2025</div>
                    </div>
                    <div class="bg-white bg-opacity-10 backdrop-blur-sm rounded-xl p-6">
                        <div class="text-5xl font-bold text-yellow-300 mb-2">85+</div>
                        <div class="text-indigo-200">Meta ENARE 2026</div>
                        <div class="text-xs mt-2 text-indigo-300">De 58 para 85 questões</div>
                    </div>
                    <div class="bg-white bg-opacity-10 backdrop-blur-sm rounded-xl p-6">
                        <div class="text-5xl font-bold text-yellow-300 mb-2">15K</div>
                        <div class="text-indigo-200">Questões até set/2026</div>
                        <div class="text-xs mt-2 text-indigo-300">Método estruturado</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Vídeo Tutorial -->
        <div id="video" class="py-20 px-4 bg-white">
            <div class="max-w-5xl mx-auto">
                <div class="text-center mb-12">
                    <span class="bg-indigo-100 text-indigo-600 px-4 py-2 rounded-full text-sm font-bold">📹 VÍDEO TUTORIAL</span>
                    <h2 class="text-4xl md:text-5xl font-bold text-gray-800 mt-6 mb-4">
                        Veja Como Funciona em <span class="text-indigo-600">5 Minutos</span>
                    </h2>
                    <p class="text-xl text-gray-600">
                        Entenda todo o sistema, do planejamento às revisões inteligentes
                    </p>
                </div>
                <div class="relative rounded-2xl overflow-hidden shadow-2xl" style="padding-bottom: 56.25%; position: relative;">
                    <!-- Placeholder para vídeo do YouTube -->
                    <div class="absolute inset-0 bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center">
                        <div class="text-center text-white">
                            <i class="fas fa-play-circle text-8xl mb-6 opacity-80"></i>
                            <p class="text-2xl font-bold mb-2">Vídeo em breve!</p>
                            <p class="text-indigo-200">Tutorial completo da plataforma</p>
                            <div class="mt-8 bg-white bg-opacity-20 backdrop-blur-sm rounded-lg p-4 max-w-md mx-auto">
                                <p class="text-sm text-left">
                                    <strong>📝 Quando o vídeo estiver pronto:</strong><br/>
                                    Substitua esta div por:<br/>
                                    <code class="text-xs bg-black bg-opacity-20 p-1 rounded">
                                        &lt;iframe src="URL_DO_YOUTUBE"&gt;&lt;/iframe&gt;
                                    </code>
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Método Detalhado -->
        <div class="py-20 px-4 bg-gray-50">
            <div class="max-w-6xl mx-auto">
                <div class="text-center mb-16">
                    <span class="bg-green-100 text-green-600 px-4 py-2 rounded-full text-sm font-bold">🎯 METODOLOGIA COMPROVADA</span>
                    <h2 class="text-4xl md:text-5xl font-bold text-gray-800 mt-6 mb-4">
                        O Método que <span class="text-green-600">Funciona</span>
                    </h2>
                    <p class="text-xl text-gray-600">
                        2 métodos complementares adaptados para cada área do ENARE
                    </p>
                </div>

                <div class="grid md:grid-cols-2 gap-8 mb-16">
                    <!-- Método com Questões -->
                    <div class="bg-white rounded-2xl shadow-lg p-8 method-card border-l-indigo-600">
                        <div class="flex items-center mb-6">
                            <div class="bg-indigo-100 rounded-full p-4 mr-4">
                                <i class="fas fa-question-circle text-3xl text-indigo-600"></i>
                            </div>
                            <div>
                                <h3 class="text-2xl font-bold text-gray-800">Método com Questões</h3>
                                <p class="text-sm text-indigo-600 font-semibold">Clínica Médica • Cirurgia • GO</p>
                            </div>
                        </div>
                        <ol class="space-y-4 text-gray-700">
                            <li class="flex items-start">
                                <span class="bg-indigo-600 text-white rounded-full w-7 h-7 flex items-center justify-center mr-3 flex-shrink-0 font-bold text-sm">1</span>
                                <div>
                                    <strong>Escolha do tema</strong>
                                    <p class="text-sm text-gray-600">Ex.: Hemorragia Digestiva Alta</p>
                                </div>
                            </li>
                            <li class="flex items-start">
                                <span class="bg-indigo-600 text-white rounded-full w-7 h-7 flex items-center justify-center mr-3 flex-shrink-0 font-bold text-sm">2</span>
                                <div>
                                    <strong>Abrir seção de estudos</strong>
                                    <p class="text-sm text-gray-600">1h para cada tema, pelo menos</p>
                                </div>
                            </li>
                            <li class="flex items-start">
                                <span class="bg-indigo-600 text-white rounded-full w-7 h-7 flex items-center justify-center mr-3 flex-shrink-0 font-bold text-sm">3</span>
                                <div>
                                    <strong>Definir 15-20 questões</strong>
                                    <p class="text-sm text-gray-600">Dos últimos 5 anos (atenção a temas atualizados frequentemente)</p>
                                </div>
                            </li>
                            <li class="flex items-start">
                                <span class="bg-indigo-600 text-white rounded-full w-7 h-7 flex items-center justify-center mr-3 flex-shrink-0 font-bold text-sm">4</span>
                                <div>
                                    <strong>Análise profunda</strong>
                                    <p class="text-sm text-gray-600">Qual conhecimento cobrou? O quanto sabia? Padrões nas questões?</p>
                                </div>
                            </li>
                            <li class="flex items-start">
                                <span class="bg-indigo-600 text-white rounded-full w-7 h-7 flex items-center justify-center mr-3 flex-shrink-0 font-bold text-sm">5</span>
                                <div>
                                    <strong>Revisar comentários</strong>
                                    <p class="text-sm text-gray-600">TODAS as questões, inclusive corretas (macetes práticos!)</p>
                                </div>
                            </li>
                            <li class="flex items-start">
                                <span class="bg-indigo-600 text-white rounded-full w-7 h-7 flex items-center justify-center mr-3 flex-shrink-0 font-bold text-sm">6</span>
                                <div>
                                    <strong>Técnica de Feynman</strong>
                                    <p class="text-sm text-gray-600">Se explique sobre o tema com foco no que foi cobrado</p>
                                </div>
                            </li>
                        </ol>
                    </div>

                    <!-- Método Tradicional -->
                    <div class="bg-white rounded-2xl shadow-lg p-8 method-card border-l-green-600">
                        <div class="flex items-center mb-6">
                            <div class="bg-green-100 rounded-full p-4 mr-4">
                                <i class="fas fa-book text-3xl text-green-600"></i>
                            </div>
                            <div>
                                <h3 class="text-2xl font-bold text-gray-800">Método Tradicional</h3>
                                <p class="text-sm text-green-600 font-semibold">Pediatria • Preventiva</p>
                            </div>
                        </div>
                        <ol class="space-y-4 text-gray-700">
                            <li class="flex items-start">
                                <span class="bg-green-600 text-white rounded-full w-7 h-7 flex items-center justify-center mr-3 flex-shrink-0 font-bold text-sm">1</span>
                                <div>
                                    <strong>Definir fonte</strong>
                                    <p class="text-sm text-gray-600">Aula curta com boa didática, material completo ou resumo</p>
                                </div>
                            </li>
                            <li class="flex items-start">
                                <span class="bg-green-600 text-white rounded-full w-7 h-7 flex items-center justify-center mr-3 flex-shrink-0 font-bold text-sm">2</span>
                                <div>
                                    <strong>Abrir seção de estudos</strong>
                                    <p class="text-sm text-gray-600">1h para cada tema, pelo menos</p>
                                </div>
                            </li>
                            <li class="flex items-start">
                                <span class="bg-green-600 text-white rounded-full w-7 h-7 flex items-center justify-center mr-3 flex-shrink-0 font-bold text-sm">3</span>
                                <div>
                                    <strong>Foco total</strong>
                                    <p class="text-sm text-gray-600">Atenção na aula/leitura, sem pausas, sem anotações</p>
                                </div>
                            </li>
                            <li class="flex items-start">
                                <span class="bg-green-600 text-white rounded-full w-7 h-7 flex items-center justify-center mr-3 flex-shrink-0 font-bold text-sm">4</span>
                                <div>
                                    <strong>Anotação pós-estudo</strong>
                                    <p class="text-sm text-gray-600">Anote o que lembra do conteúdo</p>
                                </div>
                            </li>
                            <li class="flex items-start">
                                <span class="bg-green-600 text-white rounded-full w-7 h-7 flex items-center justify-center mr-3 flex-shrink-0 font-bold text-sm">5</span>
                                <div>
                                    <strong>Revisão de dúvidas</strong>
                                    <p class="text-sm text-gray-600">Retorne para ajustar pontos em aberto</p>
                                </div>
                            </li>
                            <li class="flex items-start">
                                <span class="bg-green-600 text-white rounded-full w-7 h-7 flex items-center justify-center mr-3 flex-shrink-0 font-bold text-sm">6</span>
                                <div>
                                    <strong>Auto-explicação</strong>
                                    <p class="text-sm text-gray-600">Explique em 10min - organize as gavetas mentais</p>
                                </div>
                            </li>
                            <li class="flex items-start">
                                <span class="bg-green-600 text-white rounded-full w-7 h-7 flex items-center justify-center mr-3 flex-shrink-0 font-bold text-sm">7</span>
                                <div>
                                    <strong>FlashCards no dia seguinte</strong>
                                    <p class="text-sm text-gray-600">Use plataformas prontas (MedCards, Estratégia)</p>
                                </div>
                            </li>
                        </ol>
                    </div>
                </div>

                <!-- Planejamento -->
                <div class="bg-gradient-to-br from-yellow-400 to-orange-500 rounded-2xl shadow-2xl p-8 md:p-12 text-gray-900">
                    <div class="text-center mb-8">
                        <i class="fas fa-trophy text-6xl text-white mb-4"></i>
                        <h3 class="text-3xl md:text-4xl font-bold text-white mb-2">Planejamento R1 Completo</h3>
                        <p class="text-white text-opacity-90">Sua evolução mapeada até setembro de 2026</p>
                    </div>
                    <div class="grid md:grid-cols-3 gap-6 mb-8">
                        <div class="bg-white bg-opacity-20 backdrop-blur-sm rounded-xl p-6 text-center">
                            <div class="text-3xl font-bold text-white mb-2">58</div>
                            <div class="text-sm text-white text-opacity-80">ENARE 2024</div>
                        </div>
                        <div class="bg-white bg-opacity-30 backdrop-blur-sm rounded-xl p-6 text-center">
                            <div class="text-3xl font-bold text-white mb-2">64</div>
                            <div class="text-sm text-white text-opacity-80">ENARE 2025</div>
                        </div>
                        <div class="bg-white bg-opacity-40 backdrop-blur-sm rounded-xl p-6 text-center border-4 border-white">
                            <div class="text-4xl font-bold text-white mb-2">85+</div>
                            <div class="text-sm text-white font-bold">🎯 META ENARE 2026</div>
                        </div>
                    </div>
                    <div class="bg-white rounded-xl p-6 shadow-lg">
                        <h4 class="text-xl font-bold mb-4 text-gray-800">📊 Metas até Setembro/2026:</h4>
                        <ul class="space-y-3 text-gray-700">
                            <li class="flex items-center">
                                <i class="fas fa-check-circle text-green-600 mr-3"></i>
                                <strong>15.000 questões resolvidas no total</strong>
                            </li>
                            <li class="flex items-center">
                                <i class="fas fa-check-circle text-green-600 mr-3"></i>
                                <strong>Método com questões:</strong> Clínica Médica, Cirurgia e GO
                            </li>
                            <li class="flex items-center">
                                <i class="fas fa-check-circle text-green-600 mr-3"></i>
                                <strong>Método tradicional:</strong> Pediatria e Preventiva
                            </li>
                            <li class="flex items-center">
                                <i class="fas fa-check-circle text-green-600 mr-3"></i>
                                <strong>419 temas cobertos</strong> em 40 semanas de ciclo
                            </li>
                            <li class="flex items-center">
                                <i class="fas fa-check-circle text-green-600 mr-3"></i>
                                <strong>3 níveis de revisão</strong> espaçada automática (1, 7, 30 dias)
                            </li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>

        <!-- Features Section -->
        <div class="py-20 px-4 bg-white">
            <div class="max-w-6xl mx-auto">
                <div class="text-center mb-16">
                    <span class="bg-purple-100 text-purple-600 px-4 py-2 rounded-full text-sm font-bold">⚡ RECURSOS DA PLATAFORMA</span>
                    <h2 class="text-4xl md:text-5xl font-bold text-gray-800 mt-6 mb-4">
                        Tudo que Você Precisa em <span class="text-purple-600">Um Só Lugar</span>
                    </h2>
                </div>
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

        <!-- Comparação: Antes vs Depois -->
        <div class="py-20 px-4 bg-gray-50">
            <div class="max-w-6xl mx-auto">
                <div class="text-center mb-16">
                    <span class="bg-red-100 text-red-600 px-4 py-2 rounded-full text-sm font-bold">⚖️ TRANSFORMAÇÃO</span>
                    <h2 class="text-4xl md:text-5xl font-bold text-gray-800 mt-6 mb-4">
                        Antes <span class="text-red-600">vs</span> Depois do HardMed
                    </h2>
                </div>
                <div class="grid md:grid-cols-2 gap-8">
                    <!-- Antes -->
                    <div class="bg-white rounded-2xl shadow-lg p-8 border-4 border-red-200">
                        <div class="text-center mb-6">
                            <i class="fas fa-times-circle text-5xl text-red-500 mb-4"></i>
                            <h3 class="text-2xl font-bold text-gray-800">😰 Sem Planejamento</h3>
                        </div>
                        <ul class="space-y-4 text-gray-700">
                            <li class="flex items-start">
                                <i class="fas fa-times text-red-500 mr-3 mt-1"></i>
                                <span>Não sabe por onde começar os 419 temas</span>
                            </li>
                            <li class="flex items-start">
                                <i class="fas fa-times text-red-500 mr-3 mt-1"></i>
                                <span>Estuda hoje, esquece amanhã (sem revisões)</span>
                            </li>
                            <li class="flex items-start">
                                <i class="fas fa-times text-red-500 mr-3 mt-1"></i>
                                <span>Perde tempo decidindo o que estudar</span>
                            </li>
                            <li class="flex items-start">
                                <i class="fas fa-times text-red-500 mr-3 mt-1"></i>
                                <span>Sem noção do progresso real</span>
                            </li>
                            <li class="flex items-start">
                                <i class="fas fa-times text-red-500 mr-3 mt-1"></i>
                                <span>Ansiedade constante sobre o que falta</span>
                            </li>
                            <li class="flex items-start">
                                <i class="fas fa-times text-red-500 mr-3 mt-1"></i>
                                <span>Método desorganizado e ineficiente</span>
                            </li>
                        </ul>
                    </div>

                    <!-- Depois -->
                    <div class="bg-gradient-to-br from-green-400 to-blue-500 rounded-2xl shadow-2xl p-8 border-4 border-green-300 text-white">
                        <div class="text-center mb-6">
                            <i class="fas fa-check-circle text-5xl mb-4"></i>
                            <h3 class="text-2xl font-bold">😎 Com HardMed</h3>
                        </div>
                        <ul class="space-y-4">
                            <li class="flex items-start">
                                <i class="fas fa-check mr-3 mt-1"></i>
                                <span><strong>419 temas organizados</strong> em 40 semanas</span>
                            </li>
                            <li class="flex items-start">
                                <i class="fas fa-check mr-3 mt-1"></i>
                                <span><strong>Revisões automáticas</strong> em 1, 7 e 30 dias</span>
                            </li>
                            <li class="flex items-start">
                                <i class="fas fa-check mr-3 mt-1"></i>
                                <span><strong>Guia diário</strong> mostra exatamente o que fazer</span>
                            </li>
                            <li class="flex items-start">
                                <i class="fas fa-check mr-3 mt-1"></i>
                                <span><strong>Métricas em tempo real</strong> de evolução</span>
                            </li>
                            <li class="flex items-start">
                                <i class="fas fa-check mr-3 mt-1"></i>
                                <span><strong>Confiança total</strong> no seu processo</span>
                            </li>
                            <li class="flex items-start">
                                <i class="fas fa-check mr-3 mt-1"></i>
                                <span><strong>Método comprovado</strong> + 27 questões/ano</span>
                            </li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>

        <!-- FAQ -->
        <div class="py-20 px-4 bg-white">
            <div class="max-w-4xl mx-auto">
                <div class="text-center mb-16">
                    <span class="bg-blue-100 text-blue-600 px-4 py-2 rounded-full text-sm font-bold">❓ DÚVIDAS FREQUENTES</span>
                    <h2 class="text-4xl md:text-5xl font-bold text-gray-800 mt-6 mb-4">
                        Perguntas e Respostas
                    </h2>
                </div>
                <div class="space-y-6">
                    <details class="bg-gray-50 rounded-xl p-6 cursor-pointer hover:bg-gray-100 transition">
                        <summary class="text-lg font-bold text-gray-800 mb-2">🎯 Como funciona o ciclo de 40 semanas?</summary>
                        <p class="text-gray-600 ml-4">Os 419 temas do ENARE são distribuídos em 40 semanas, priorizando temas de alta prevalência e balanceando todas as áreas (Clínica, Cirurgia, GO, Pediatria, Preventiva). Cada semana tem um conjunto específico de temas novos + revisões programadas.</p>
                    </details>

                    <details class="bg-gray-50 rounded-xl p-6 cursor-pointer hover:bg-gray-100 transition">
                        <summary class="text-lg font-bold text-gray-800 mb-2">🔄 Como são as revisões espaçadas?</summary>
                        <p class="text-gray-600 ml-4">Após estudar um tema, o sistema programa automaticamente 3 revisões: 1 dia depois, 7 dias depois e 30 dias depois. Isso garante fixação na memória de longo prazo com base em evidências científicas.</p>
                    </details>

                    <details class="bg-gray-50 rounded-xl p-6 cursor-pointer hover:bg-gray-100 transition">
                        <summary class="text-lg font-bold text-gray-800 mb-2">📊 Quais métricas a plataforma oferece?</summary>
                        <p class="text-gray-600 ml-4">Você acompanha: total de questões resolvidas, acurácia por área, tempo de estudo, progresso no ciclo de 40 semanas, temas estudados vs pendentes, revisões concluídas e muito mais!</p>
                    </details>

                    <details class="bg-gray-50 rounded-xl p-6 cursor-pointer hover:bg-gray-100 transition">
                        <summary class="text-lg font-bold text-gray-800 mb-2">💰 A plataforma é gratuita?</summary>
                        <p class="text-gray-600 ml-4">Sim! O HardMed é 100% gratuito. Foi desenvolvido por um residente para ajudar outros estudantes a passarem no ENARE com um método estruturado e eficiente.</p>
                    </details>

                    <details class="bg-gray-50 rounded-xl p-6 cursor-pointer hover:bg-gray-100 transition">
                        <summary class="text-lg font-bold text-gray-800 mb-2">⏰ Quanto tempo preciso estudar por dia?</summary>
                        <p class="text-gray-600 ml-4">O método recomenda pelo menos 1h por tema. A plataforma te ajuda a organizar, mas você define seu ritmo. O importante é consistência + método correto.</p>
                    </details>

                    <details class="bg-gray-50 rounded-xl p-6 cursor-pointer hover:bg-gray-100 transition">
                        <summary class="text-lg font-bold text-gray-800 mb-2">🎓 Funciona para outras provas além do ENARE?</summary>
                        <p class="text-gray-600 ml-4">Sim! Apesar de ser otimizado para ENARE, o método de revisões espaçadas e organização por temas funciona para qualquer prova de residência médica.</p>
                    </details>
                </div>
            </div>
        </div>

        <!-- CTA Final -->
        <div class="gradient-bg py-20 px-4 relative overflow-hidden">
            <div class="absolute inset-0 opacity-10">
                <div class="absolute top-10 left-10 text-white text-8xl"><i class="fas fa-graduation-cap"></i></div>
                <div class="absolute bottom-10 right-10 text-white text-8xl"><i class="fas fa-trophy"></i></div>
            </div>
            <div class="max-w-4xl mx-auto text-center text-white relative z-10">
                <div class="mb-6">
                    <i class="fas fa-rocket text-6xl mb-4"></i>
                </div>
                <h2 class="text-4xl md:text-5xl font-bold mb-6">
                    Está Pronto para <span class="text-yellow-300">Transformar</span><br/>
                    Seus Estudos?
                </h2>
                <p class="text-xl md:text-2xl mb-8 opacity-90 max-w-2xl mx-auto">
                    Junte-se aos residentes que saíram do <strong>caos</strong> para o <strong>planejamento</strong><br/>
                    e estão dominando o ENARE 2026
                </p>
                <div class="flex flex-col md:flex-row justify-center gap-4 mb-8">
                    <a href="/login?registro=true" class="bg-yellow-400 text-gray-900 px-12 py-5 rounded-xl font-bold text-xl hover:bg-yellow-300 transition shadow-2xl pulse-glow inline-flex items-center justify-center">
                        <i class="fas fa-rocket mr-2"></i>CRIAR CONTA GRÁTIS AGORA
                    </a>
                    <a href="/login" class="bg-white bg-opacity-20 backdrop-blur-sm text-white px-12 py-5 rounded-xl font-bold text-xl hover:bg-opacity-30 transition shadow-xl inline-flex items-center justify-center border-2 border-white">
                        <i class="fas fa-sign-in-alt mr-2"></i>Já Tenho Conta
                    </a>
                </div>
                <div class="flex items-center justify-center space-x-8 text-sm opacity-80">
                    <div class="flex items-center">
                        <i class="fas fa-check-circle mr-2"></i>
                        <span>100% Gratuito</span>
                    </div>
                    <div class="flex items-center">
                        <i class="fas fa-check-circle mr-2"></i>
                        <span>Sem Cartão</span>
                    </div>
                    <div class="flex items-center">
                        <i class="fas fa-check-circle mr-2"></i>
                        <span>Comece em 2 Minutos</span>
                    </div>
                </div>
            </div>
        </div>

        <!-- Footer -->
        <footer class="text-center py-6 mt-12 text-gray-400 text-sm">
            <p>Criado com muito <span class="text-red-500">❤️</span> por <strong>Erique Melo</strong> e muito ☕</p>
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
                    <label class="block text-gray-700 font-semibold mb-2">Data da Prova <span class="text-red-600">*</span></label>
                    <input type="date" id="registro-data-prova" required
                        class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        min="<?= date('Y-m-d') ?>">
                    <p class="text-sm text-gray-600 mt-1">
                        <i class="fas fa-info-circle mr-1"></i>Necessário para gerar seu ciclo de estudos personalizado
                    </p>
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
                    setTimeout(() => window.location.href = '/dashboard', 1000)
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
                    setTimeout(() => window.location.href = '/dashboard', 1000)
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

// ====================================================
// ADMIN: DASHBOARD
// ====================================================
app.get('/admin', async (c) => {
  const auth = await requireAdmin(c)
  if (auth.error) {
    return c.redirect('/login')
  }

  return c.html(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>🛠️ Painel Admin - HardMed</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
    </head>
    <body class="bg-gray-100 min-h-screen">
        <!-- Header Admin -->
        <header class="bg-gradient-to-r from-red-600 via-pink-600 to-purple-600 shadow-2xl">
            <div class="max-w-7xl mx-auto px-4 py-6">
                <div class="flex items-center justify-between">
                    <div class="flex items-center space-x-4">
                        <div class="bg-white bg-opacity-20 p-3 rounded-xl">
                            <i class="fas fa-shield-alt text-white text-3xl"></i>
                        </div>
                        <div>
                            <h1 class="text-3xl font-bold text-white">Painel do Administrador</h1>
                            <p class="text-pink-100">Gerenciamento da Plataforma HardMed</p>
                        </div>
                    </div>
                    <div class="flex items-center space-x-4">
                        <a href="/dashboard" class="bg-white bg-opacity-20 hover:bg-opacity-30 px-4 py-2 rounded-lg text-white transition">
                            <i class="fas fa-home mr-2"></i>Voltar ao Sistema
                        </a>
                        <button onclick="logout()" class="bg-red-700 hover:bg-red-800 px-4 py-2 rounded-lg text-white transition">
                            <i class="fas fa-sign-out-alt mr-2"></i>Sair
                        </button>
                    </div>
                </div>
            </div>
        </header>

        <!-- Main Content -->
        <div class="max-w-7xl mx-auto px-4 py-8">
            <!-- Tabs -->
            <div class="flex space-x-2 mb-6">
                <button onclick="showAdminTab('overview')" class="admin-tab-btn active px-6 py-3 bg-white rounded-lg shadow font-semibold">
                    <i class="fas fa-chart-line mr-2"></i>Visão Geral
                </button>
                <button onclick="showAdminTab('usuarios')" class="admin-tab-btn px-6 py-3 bg-white rounded-lg shadow font-semibold">
                    <i class="fas fa-users mr-2"></i>Usuários
                </button>
                <button onclick="showAdminTab('temas')" class="admin-tab-btn px-6 py-3 bg-white rounded-lg shadow font-semibold">
                    <i class="fas fa-book mr-2"></i>Temas
                </button>
            </div>

            <!-- Tab: Visão Geral -->
            <div id="admin-tab-overview" class="admin-tab-content">
                <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
                    <!-- Card: Total Usuários -->
                    <div class="bg-white rounded-xl shadow-lg p-6">
                        <div class="flex items-center justify-between">
                            <div>
                                <p class="text-gray-600 text-sm">Total de Usuários</p>
                                <p class="text-4xl font-bold text-indigo-600" id="admin-total-users">--</p>
                            </div>
                            <i class="fas fa-users text-5xl text-indigo-200"></i>
                        </div>
                    </div>

                    <!-- Card: Total Temas -->
                    <div class="bg-white rounded-xl shadow-lg p-6">
                        <div class="flex items-center justify-between">
                            <div>
                                <p class="text-gray-600 text-sm">Total de Temas</p>
                                <p class="text-4xl font-bold text-green-600" id="admin-total-temas">--</p>
                            </div>
                            <i class="fas fa-book text-5xl text-green-200"></i>
                        </div>
                    </div>

                    <!-- Card: Total Estudos -->
                    <div class="bg-white rounded-xl shadow-lg p-6">
                        <div class="flex items-center justify-between">
                            <div>
                                <p class="text-gray-600 text-sm">Total de Estudos</p>
                                <p class="text-4xl font-bold text-purple-600" id="admin-total-estudos">--</p>
                            </div>
                            <i class="fas fa-graduation-cap text-5xl text-purple-200"></i>
                        </div>
                    </div>
                </div>

                <!-- Gráfico de Atividade -->
                <div class="bg-white rounded-xl shadow-lg p-6">
                    <h2 class="text-2xl font-bold text-gray-800 mb-4">
                        <i class="fas fa-chart-bar text-indigo-600 mr-2"></i>Estatísticas da Plataforma
                    </h2>
                    <div id="admin-stats" class="space-y-4">
                        <p class="text-gray-600">Carregando estatísticas...</p>
                    </div>
                </div>
            </div>

            <!-- Tab: Usuários -->
            <div id="admin-tab-usuarios" class="admin-tab-content hidden">
                <div class="bg-white rounded-xl shadow-lg p-6">
                    <div class="flex items-center justify-between mb-4">
                        <h2 class="text-2xl font-bold text-gray-800">
                            <i class="fas fa-users text-indigo-600 mr-2"></i>Gerenciar Usuários
                        </h2>
                        <input type="text" id="search-users" placeholder="Buscar usuário..." class="px-4 py-2 border rounded-lg">
                    </div>
                    <div id="admin-users-list" class="space-y-2">
                        <p class="text-gray-600">Carregando usuários...</p>
                    </div>
                </div>
            </div>

            <!-- Tab: Temas -->
            <div id="admin-tab-temas" class="admin-tab-content hidden">
                <div class="bg-white rounded-xl shadow-lg p-6 mb-6">
                    <div class="flex items-center justify-between mb-4">
                        <h2 class="text-2xl font-bold text-gray-800">
                            <i class="fas fa-book text-indigo-600 mr-2"></i>Gerenciar Temas
                        </h2>
                        <div class="flex space-x-2">
                            <button onclick="showAddTemaModal()" class="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg">
                                <i class="fas fa-plus mr-2"></i>Adicionar Tema
                            </button>
                            <input type="text" id="search-temas" placeholder="Buscar tema..." class="px-4 py-2 border rounded-lg">
                        </div>
                    </div>
                    <div id="admin-temas-list" class="space-y-2">
                        <p class="text-gray-600">Carregando temas...</p>
                    </div>
                </div>
            </div>
        </div>

        <!-- Modal: Adicionar Tema -->
        <div id="modal-add-tema" class="hidden fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div class="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
                <div class="sticky top-0 bg-gradient-to-r from-green-600 to-blue-600 text-white px-6 py-4 rounded-t-2xl flex items-center justify-between">
                    <h3 class="text-2xl font-bold flex items-center">
                        <i class="fas fa-plus-circle mr-3"></i>Adicionar Novo Tema
                    </h3>
                    <button onclick="closeAddTemaModal()" class="text-white hover:text-gray-200 text-2xl">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <form id="form-add-tema" class="p-6 space-y-4">
                    <div>
                        <label class="block text-gray-700 font-semibold mb-2">Tema *</label>
                        <input type="text" id="add-tema" required class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500" placeholder="Ex: Hemorragia Digestiva Alta">
                    </div>
                    <div class="grid grid-cols-2 gap-4">
                        <div>
                            <label class="block text-gray-700 font-semibold mb-2">Área *</label>
                            <select id="add-area" required class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500">
                                <option value="">Selecione...</option>
                                <option value="Clínica Médica">Clínica Médica</option>
                                <option value="Cirurgia">Cirurgia</option>
                                <option value="Ginecologia e Obstetrícia">Ginecologia e Obstetrícia</option>
                                <option value="Pediatria">Pediatria</option>
                                <option value="Medicina Preventiva">Medicina Preventiva</option>
                                <option value="Saúde da Família">Saúde da Família</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-gray-700 font-semibold mb-2">Subárea *</label>
                            <input type="text" id="add-subarea" required class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500" placeholder="Ex: Gastroenterologia">
                        </div>
                    </div>
                    <div>
                        <label class="block text-gray-700 font-semibold mb-2">Subtópicos</label>
                        <textarea id="add-subtopicos" rows="3" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500" placeholder="Separados por vírgula ou enter"></textarea>
                    </div>
                    <div class="grid grid-cols-3 gap-4">
                        <div>
                            <label class="block text-gray-700 font-semibold mb-2">Prevalência *</label>
                            <select id="add-prevalencia" required class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500">
                                <option value="">Selecione...</option>
                                <option value="Muito Alta">Muito Alta</option>
                                <option value="Alta">Alta</option>
                                <option value="Média">Média</option>
                                <option value="Baixa">Baixa</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-gray-700 font-semibold mb-2">Prev. Número *</label>
                            <input type="number" id="add-prevalencia-numero" required min="1" max="5" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500" placeholder="1-5">
                        </div>
                        <div>
                            <label class="block text-gray-700 font-semibold mb-2">Prioridade</label>
                            <input type="text" id="add-prioridade" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500" placeholder="Ex: P1">
                        </div>
                    </div>
                    <div class="flex space-x-4 pt-4">
                        <button type="submit" class="flex-1 bg-gradient-to-r from-green-600 to-blue-600 text-white py-3 rounded-lg font-bold hover:from-green-700 hover:to-blue-700 transition">
                            <i class="fas fa-save mr-2"></i>Salvar Tema
                        </button>
                        <button type="button" onclick="closeAddTemaModal()" class="px-6 bg-gray-300 text-gray-700 py-3 rounded-lg font-bold hover:bg-gray-400 transition">
                            Cancelar
                        </button>
                    </div>
                </form>
            </div>
        </div>

        <!-- Modal: Editar Tema -->
        <div id="modal-edit-tema" class="hidden fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div class="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
                <div class="sticky top-0 bg-gradient-to-r from-yellow-500 to-orange-500 text-white px-6 py-4 rounded-t-2xl flex items-center justify-between">
                    <h3 class="text-2xl font-bold flex items-center">
                        <i class="fas fa-edit mr-3"></i>Editar Tema
                    </h3>
                    <button onclick="closeEditTemaModal()" class="text-white hover:text-gray-200 text-2xl">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <form id="form-edit-tema" class="p-6 space-y-4">
                    <input type="hidden" id="edit-id">
                    <div>
                        <label class="block text-gray-700 font-semibold mb-2">Tema *</label>
                        <input type="text" id="edit-tema" required class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-yellow-500">
                    </div>
                    <div class="grid grid-cols-2 gap-4">
                        <div>
                            <label class="block text-gray-700 font-semibold mb-2">Área *</label>
                            <select id="edit-area" required class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-yellow-500">
                                <option value="Clínica Médica">Clínica Médica</option>
                                <option value="Cirurgia">Cirurgia</option>
                                <option value="Ginecologia e Obstetrícia">Ginecologia e Obstetrícia</option>
                                <option value="Pediatria">Pediatria</option>
                                <option value="Medicina Preventiva">Medicina Preventiva</option>
                                <option value="Saúde da Família">Saúde da Família</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-gray-700 font-semibold mb-2">Subárea *</label>
                            <input type="text" id="edit-subarea" required class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-yellow-500">
                        </div>
                    </div>
                    <div>
                        <label class="block text-gray-700 font-semibold mb-2">Subtópicos</label>
                        <textarea id="edit-subtopicos" rows="3" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-yellow-500"></textarea>
                    </div>
                    <div class="grid grid-cols-3 gap-4">
                        <div>
                            <label class="block text-gray-700 font-semibold mb-2">Prevalência *</label>
                            <select id="edit-prevalencia" required class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-yellow-500">
                                <option value="Muito Alta">Muito Alta</option>
                                <option value="Alta">Alta</option>
                                <option value="Média">Média</option>
                                <option value="Baixa">Baixa</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-gray-700 font-semibold mb-2">Prev. Número *</label>
                            <input type="number" id="edit-prevalencia-numero" required min="1" max="5" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-yellow-500">
                        </div>
                        <div>
                            <label class="block text-gray-700 font-semibold mb-2">Prioridade</label>
                            <input type="text" id="edit-prioridade" class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-yellow-500">
                        </div>
                    </div>
                    <div class="flex space-x-4 pt-4">
                        <button type="submit" class="flex-1 bg-gradient-to-r from-yellow-500 to-orange-500 text-white py-3 rounded-lg font-bold hover:from-yellow-600 hover:to-orange-600 transition">
                            <i class="fas fa-save mr-2"></i>Atualizar Tema
                        </button>
                        <button type="button" onclick="closeEditTemaModal()" class="px-6 bg-gray-300 text-gray-700 py-3 rounded-lg font-bold hover:bg-gray-400 transition">
                            Cancelar
                        </button>
                    </div>
                </form>
            </div>
        </div>

        <!-- Modal: Detalhes do Aluno -->
        <div id="modal-user-details" class="hidden fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4 overflow-y-auto">
            <div class="bg-white rounded-2xl shadow-2xl max-w-6xl w-full max-h-[95vh] overflow-y-auto my-4">
                <div class="sticky top-0 bg-gradient-to-r from-indigo-600 to-purple-600 text-white px-6 py-4 rounded-t-2xl flex items-center justify-between z-10">
                    <h3 class="text-2xl font-bold flex items-center">
                        <i class="fas fa-user-graduate mr-3"></i>
                        <span id="user-details-name">Detalhes do Aluno</span>
                    </h3>
                    <div class="flex items-center space-x-3">
                        <button onclick="exportUserPDF()" class="bg-white bg-opacity-20 hover:bg-opacity-30 px-4 py-2 rounded-lg transition flex items-center">
                            <i class="fas fa-file-pdf mr-2"></i>Exportar PDF
                        </button>
                        <button onclick="closeUserDetailsModal()" class="text-white hover:text-gray-200 text-2xl">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                </div>
                
                <div id="user-details-content" class="p-6">
                    <div class="text-center py-12">
                        <i class="fas fa-spinner fa-spin text-4xl text-indigo-600"></i>
                        <p class="text-gray-600 mt-4">Carregando dados do aluno...</p>
                    </div>
                </div>
            </div>
        </div>

        <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
        <script>
            // Tabs
            function showAdminTab(tabName) {
                document.querySelectorAll('.admin-tab-content').forEach(tab => tab.classList.add('hidden'))
                document.querySelectorAll('.admin-tab-btn').forEach(btn => btn.classList.remove('active', 'bg-indigo-600', 'text-white'))
                
                document.getElementById(\`admin-tab-\${tabName}\`).classList.remove('hidden')
                event.target.closest('.admin-tab-btn').classList.add('active', 'bg-indigo-600', 'text-white')
                
                if (tabName === 'overview') loadAdminOverview()
                if (tabName === 'usuarios') loadAdminUsers()
                if (tabName === 'temas') loadAdminTemas()
            }

            // Load Overview
            async function loadAdminOverview() {
                const res = await fetch('/api/admin/stats')
                const data = await res.json()
                
                document.getElementById('admin-total-users').textContent = data.total_usuarios || 0
                document.getElementById('admin-total-temas').textContent = data.total_temas || 0
                document.getElementById('admin-total-estudos').textContent = data.total_estudos || 0
                
                document.getElementById('admin-stats').innerHTML = \`
                    <div class="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
                        <div class="border-l-4 border-indigo-500 pl-4">
                            <p class="text-gray-600 text-sm">Usuários Ativos (7 dias)</p>
                            <p class="text-2xl font-bold">\${data.usuarios_ativos_7d || 0}</p>
                        </div>
                        <div class="border-l-4 border-blue-500 pl-4">
                            <p class="text-gray-600 text-sm">Usuários Ativos (30 dias)</p>
                            <p class="text-2xl font-bold">\${data.usuarios_ativos_30d || 0}</p>
                        </div>
                        <div class="border-l-4 border-cyan-500 pl-4">
                            <p class="text-gray-600 text-sm">Novos Usuários (7 dias)</p>
                            <p class="text-2xl font-bold">\${data.novos_usuarios_7d || 0}</p>
                        </div>
                        <div class="border-l-4 border-green-500 pl-4">
                            <p class="text-gray-600 text-sm">Estudos Hoje</p>
                            <p class="text-2xl font-bold">\${data.estudos_hoje || 0}</p>
                        </div>
                        <div class="border-l-4 border-orange-500 pl-4">
                            <p class="text-gray-600 text-sm">Questões Resolvidas</p>
                            <p class="text-2xl font-bold">\${data.questoes_total || 0}</p>
                        </div>
                        <div class="border-l-4 border-yellow-500 pl-4">
                            <p class="text-gray-600 text-sm">Tempo Total de Estudo</p>
                            <p class="text-2xl font-bold">\${Math.floor((data.tempo_estudo_total || 0) / 60)}h</p>
                        </div>
                        <div class="border-l-4 border-purple-500 pl-4">
                            <p class="text-gray-600 text-sm">Revisões Pendentes</p>
                            <p class="text-2xl font-bold">\${data.revisoes_pendentes || 0}</p>
                        </div>
                        <div class="border-l-4 border-pink-500 pl-4">
                            <p class="text-gray-600 text-sm">Revisões Concluídas</p>
                            <p class="text-2xl font-bold">\${data.revisoes_concluidas || 0}</p>
                        </div>
                        <div class="border-l-4 border-red-500 pl-4">
                            <p class="text-gray-600 text-sm">Acurácia Média Geral</p>
                            <p class="text-2xl font-bold">\${(data.acuracia_media_geral || 0).toFixed(1)}%</p>
                        </div>
                        <div class="border-l-4 border-teal-500 pl-4">
                            <p class="text-gray-600 text-sm">Temas Estudados</p>
                            <p class="text-2xl font-bold">\${data.temas_estudados || 0} / \${data.total_temas || 0}</p>
                        </div>
                    </div>
                \`
            }

            // Load Users
            async function loadAdminUsers() {
                const res = await fetch('/api/admin/usuarios')
                const data = await res.json()
                
                const listDiv = document.getElementById('admin-users-list')
                if (data.usuarios && data.usuarios.length > 0) {
                    listDiv.innerHTML = data.usuarios.map(u => \`
                        <div class="border rounded-lg p-4 hover:border-indigo-400 transition flex items-center justify-between">
                            <div class="flex-1">
                                <h3 class="font-bold text-gray-800">\${u.nome}</h3>
                                <p class="text-sm text-gray-600">\${u.email}</p>
                                <p class="text-xs text-gray-500 mt-1">
                                    Cadastro: \${new Date(u.created_at).toLocaleDateString('pt-BR')} · 
                                    Último acesso: \${u.last_login ? new Date(u.last_login).toLocaleDateString('pt-BR') : 'Nunca'}
                                    \${u.is_admin ? ' · <span class="text-red-600 font-bold">ADMIN</span>' : ''}
                                </p>
                            </div>
                            <div class="flex space-x-2">
                                <button onclick="viewUserDetails(\${u.id})" class="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded text-sm">
                                    <i class="fas fa-eye mr-1"></i>Detalhes
                                </button>
                            </div>
                        </div>
                    \`).join('')
                } else {
                    listDiv.innerHTML = '<p class="text-gray-600">Nenhum usuário encontrado</p>'
                }
            }

            // Load Temas
            async function loadAdminTemas() {
                const res = await fetch('/api/admin/temas')
                const data = await res.json()
                
                const listDiv = document.getElementById('admin-temas-list')
                if (data.temas && data.temas.length > 0) {
                    listDiv.innerHTML = data.temas.map(t => \`
                        <div class="border rounded-lg p-4 hover:border-indigo-400 transition">
                            <div class="flex items-start justify-between">
                                <div class="flex-1">
                                    <h3 class="font-bold text-gray-800">\${t.tema}</h3>
                                    <p class="text-sm text-gray-600">\${t.area} › \${t.subarea}</p>
                                    <p class="text-sm text-gray-500 mt-1">\${t.subtopicos || 'Sem subtópicos'}</p>
                                    <p class="text-xs text-indigo-600 mt-2">
                                        Prevalência: \${t.prevalencia} (\${t.prevalencia_numero}) · 
                                        Prioridade: \${t.prioridade || 'N/A'}
                                    </p>
                                </div>
                                <div class="flex space-x-2">
                                    <button onclick="editTema(\${t.id})" class="bg-yellow-500 hover:bg-yellow-600 text-white px-3 py-1 rounded text-sm">
                                        <i class="fas fa-edit"></i>
                                    </button>
                                    <button onclick="deleteTema(\${t.id}, '\${t.tema.replace(/'/g, "\\\\'")}')" class="bg-red-500 hover:bg-red-600 text-white px-3 py-1 rounded text-sm">
                                        <i class="fas fa-trash"></i>
                                    </button>
                                </div>
                            </div>
                        </div>
                    \`).join('')
                } else {
                    listDiv.innerHTML = '<p class="text-gray-600">Nenhum tema encontrado</p>'
                }
            }

            // View User Details
            let currentUserData = null
            
            async function viewUserDetails(userId) {
                document.getElementById('modal-user-details').classList.remove('hidden')
                
                try {
                    const res = await fetch(\`/api/admin/usuarios/\${userId}/detalhes\`)
                    currentUserData = await res.json()
                    
                    if (currentUserData.error) {
                        document.getElementById('user-details-content').innerHTML = \`
                            <div class="text-center py-12">
                                <i class="fas fa-exclamation-circle text-4xl text-red-600"></i>
                                <p class="text-gray-600 mt-4">\${currentUserData.error}</p>
                            </div>
                        \`
                        return
                    }
                    
                    const u = currentUserData.usuario
                    const stats = currentUserData.stats
                    const areasData = currentUserData.por_area
                    
                    document.getElementById('user-details-name').textContent = u.nome
                    
                    // Calcular pontos fortes e fracos
                    const areas = areasData.sort((a, b) => b.acuracia - a.acuracia)
                    const pontosFortesHTML = areas.slice(0, 2).map(a => \`
                        <div class="bg-green-50 border-l-4 border-green-500 p-4 rounded">
                            <div class="flex items-center justify-between">
                                <div>
                                    <p class="font-bold text-green-800">\${a.area}</p>
                                    <p class="text-sm text-green-600">\${a.total_estudos} estudos · \${a.acuracia.toFixed(1)}% acurácia</p>
                                </div>
                                <i class="fas fa-trophy text-3xl text-green-500"></i>
                            </div>
                        </div>
                    \`).join('')
                    
                    const pontosFracosHTML = areas.slice(-2).reverse().map(a => \`
                        <div class="bg-red-50 border-l-4 border-red-500 p-4 rounded">
                            <div class="flex items-center justify-between">
                                <div>
                                    <p class="font-bold text-red-800">\${a.area}</p>
                                    <p class="text-sm text-red-600">\${a.total_estudos} estudos · \${a.acuracia.toFixed(1)}% acurácia</p>
                                </div>
                                <i class="fas fa-exclamation-triangle text-3xl text-red-500"></i>
                            </div>
                        </div>
                    \`).join('')
                    
                    // Recomendações personalizadas
                    let recomendacoes = []
                    if (stats.acuracia_media < 60) {
                        recomendacoes.push('📚 <strong>Prioridade:</strong> Revisar conceitos básicos antes de avançar')
                    }
                    if (stats.tempo_medio_minutos < 40) {
                        recomendacoes.push('⏰ <strong>Tempo:</strong> Dedicar mais tempo por tema (mínimo 60min)')
                    }
                    if (stats.dias_estudo < 10) {
                        recomendacoes.push('📅 <strong>Consistência:</strong> Estabelecer rotina diária de estudos')
                    }
                    if (stats.revisoes_pendentes > 10) {
                        recomendacoes.push('🔄 <strong>Revisões:</strong> Priorizar revisões pendentes (\${stats.revisoes_pendentes})')
                    }
                    const areasFracas = areas.filter(a => a.acuracia < 60)
                    if (areasFracas.length > 0) {
                        recomendacoes.push(\`🎯 <strong>Foco:</strong> Intensificar estudo em \${areasFracas.map(a => a.area).join(', ')}\`)
                    }
                    if (recomendacoes.length === 0) {
                        recomendacoes.push('🌟 <strong>Parabéns!</strong> Continue com o excelente trabalho!')
                    }
                    
                    document.getElementById('user-details-content').innerHTML = \`
                        <!-- Informações Básicas -->
                        <div class="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl p-6 mb-6">
                            <div class="grid md:grid-cols-4 gap-4">
                                <div>
                                    <p class="text-sm text-gray-600">Email</p>
                                    <p class="font-semibold text-gray-800">\${u.email}</p>
                                </div>
                                <div>
                                    <p class="text-sm text-gray-600">Data da Prova</p>
                                    <p class="font-semibold text-gray-800">\${u.data_prova ? new Date(u.data_prova).toLocaleDateString('pt-BR') : 'Não definida'}</p>
                                </div>
                                <div>
                                    <p class="text-sm text-gray-600">Membro desde</p>
                                    <p class="font-semibold text-gray-800">\${new Date(u.created_at).toLocaleDateString('pt-BR')}</p>
                                </div>
                                <div>
                                    <p class="text-sm text-gray-600">Último acesso</p>
                                    <p class="font-semibold text-gray-800">\${u.last_login ? new Date(u.last_login).toLocaleDateString('pt-BR') : 'Nunca'}</p>
                                </div>
                            </div>
                        </div>

                        <!-- Métricas Principais -->
                        <h3 class="text-2xl font-bold text-gray-800 mb-4 flex items-center">
                            <i class="fas fa-chart-bar text-indigo-600 mr-3"></i>Métricas Gerais
                        </h3>
                        <div class="grid md:grid-cols-4 gap-4 mb-6">
                            <div class="bg-white border-2 border-indigo-200 rounded-xl p-4 text-center">
                                <i class="fas fa-graduation-cap text-3xl text-indigo-600 mb-2"></i>
                                <p class="text-3xl font-bold text-gray-800">\${stats.total_estudos}</p>
                                <p class="text-sm text-gray-600">Estudos Realizados</p>
                            </div>
                            <div class="bg-white border-2 border-green-200 rounded-xl p-4 text-center">
                                <i class="fas fa-question-circle text-3xl text-green-600 mb-2"></i>
                                <p class="text-3xl font-bold text-gray-800">\${stats.total_questoes}</p>
                                <p class="text-sm text-gray-600">Questões Resolvidas</p>
                            </div>
                            <div class="bg-white border-2 border-blue-200 rounded-xl p-4 text-center">
                                <i class="fas fa-clock text-3xl text-blue-600 mb-2"></i>
                                <p class="text-3xl font-bold text-gray-800">\${Math.floor(stats.tempo_total_minutos / 60)}h</p>
                                <p class="text-sm text-gray-600">Tempo de Estudo</p>
                            </div>
                            <div class="bg-white border-2 border-purple-200 rounded-xl p-4 text-center">
                                <i class="fas fa-percentage text-3xl text-purple-600 mb-2"></i>
                                <p class="text-3xl font-bold text-gray-800">\${stats.acuracia_media.toFixed(1)}%</p>
                                <p class="text-sm text-gray-600">Acurácia Média</p>
                            </div>
                        </div>

                        <!-- Mais Métricas -->
                        <div class="grid md:grid-cols-4 gap-4 mb-6">
                            <div class="bg-white border-l-4 border-orange-500 rounded-lg p-4">
                                <p class="text-sm text-gray-600">Tempo Médio/Tema</p>
                                <p class="text-2xl font-bold text-gray-800">\${stats.tempo_medio_minutos.toFixed(0)}min</p>
                            </div>
                            <div class="bg-white border-l-4 border-pink-500 rounded-lg p-4">
                                <p class="text-sm text-gray-600">Dias com Estudo</p>
                                <p class="text-2xl font-bold text-gray-800">\${stats.dias_estudo}</p>
                            </div>
                            <div class="bg-white border-l-4 border-teal-500 rounded-lg p-4">
                                <p class="text-sm text-gray-600">Temas Diferentes</p>
                                <p class="text-2xl font-bold text-gray-800">\${stats.temas_estudados}</p>
                            </div>
                            <div class="bg-white border-l-4 border-red-500 rounded-lg p-4">
                                <p class="text-sm text-gray-600">Revisões Pendentes</p>
                                <p class="text-2xl font-bold text-gray-800">\${stats.revisoes_pendentes}</p>
                            </div>
                        </div>

                        <!-- Performance por Área -->
                        <h3 class="text-2xl font-bold text-gray-800 mb-4 flex items-center mt-8">
                            <i class="fas fa-star text-yellow-500 mr-3"></i>Performance por Área
                        </h3>
                        <div class="bg-white rounded-xl shadow-lg p-6 mb-6">
                            <canvas id="chart-areas" width="400" height="200"></canvas>
                        </div>

                        <!-- Pontos Fortes e Fracos -->
                        <div class="grid md:grid-cols-2 gap-6 mb-6">
                            <div>
                                <h3 class="text-xl font-bold text-green-700 mb-4 flex items-center">
                                    <i class="fas fa-check-circle mr-2"></i>Pontos Fortes
                                </h3>
                                <div class="space-y-3">
                                    \${pontosFortesHTML || '<p class="text-gray-500">Nenhum estudo registrado ainda</p>'}
                                </div>
                            </div>
                            <div>
                                <h3 class="text-xl font-bold text-red-700 mb-4 flex items-center">
                                    <i class="fas fa-times-circle mr-2"></i>Áreas para Melhorar
                                </h3>
                                <div class="space-y-3">
                                    \${pontosFracosHTML || '<p class="text-gray-500">Nenhum estudo registrado ainda</p>'}
                                </div>
                            </div>
                        </div>

                        <!-- Recomendações -->
                        <h3 class="text-2xl font-bold text-gray-800 mb-4 flex items-center mt-8">
                            <i class="fas fa-lightbulb text-yellow-500 mr-3"></i>Recomendações Personalizadas
                        </h3>
                        <div class="bg-gradient-to-r from-yellow-50 to-orange-50 border-2 border-yellow-300 rounded-xl p-6 mb-6">
                            <ul class="space-y-3">
                                \${recomendacoes.map(r => \`<li class="flex items-start"><span class="mr-2">•</span><span>\${r}</span></li>\`).join('')}
                            </ul>
                        </div>

                        <!-- Progresso no Tempo -->
                        <h3 class="text-2xl font-bold text-gray-800 mb-4 flex items-center mt-8">
                            <i class="fas fa-chart-line text-indigo-600 mr-3"></i>Evolução no Tempo
                        </h3>
                        <div class="bg-white rounded-xl shadow-lg p-6">
                            <canvas id="chart-evolucao" width="400" height="200"></canvas>
                        </div>
                    \`
                    
                    // Criar gráficos
                    setTimeout(() => {
                        // Gráfico por área
                        const ctxAreas = document.getElementById('chart-areas').getContext('2d')
                        new Chart(ctxAreas, {
                            type: 'bar',
                            data: {
                                labels: areasData.map(a => a.area),
                                datasets: [{
                                    label: 'Acurácia (%)',
                                    data: areasData.map(a => a.acuracia),
                                    backgroundColor: 'rgba(99, 102, 241, 0.6)',
                                    borderColor: 'rgba(99, 102, 241, 1)',
                                    borderWidth: 2
                                }, {
                                    label: 'Estudos',
                                    data: areasData.map(a => a.total_estudos),
                                    backgroundColor: 'rgba(34, 197, 94, 0.6)',
                                    borderColor: 'rgba(34, 197, 94, 1)',
                                    borderWidth: 2
                                }]
                            },
                            options: {
                                responsive: true,
                                plugins: {
                                    legend: { position: 'top' }
                                },
                                scales: {
                                    y: { beginAtZero: true }
                                }
                            }
                        })
                        
                        // Gráfico de evolução
                        const evolucao = currentUserData.evolucao || []
                        const ctxEvolucao = document.getElementById('chart-evolucao').getContext('2d')
                        new Chart(ctxEvolucao, {
                            type: 'line',
                            data: {
                                labels: evolucao.map(e => new Date(e.data).toLocaleDateString('pt-BR')),
                                datasets: [{
                                    label: 'Acurácia (%)',
                                    data: evolucao.map(e => e.acuracia),
                                    borderColor: 'rgba(99, 102, 241, 1)',
                                    backgroundColor: 'rgba(99, 102, 241, 0.1)',
                                    tension: 0.4,
                                    fill: true
                                }]
                            },
                            options: {
                                responsive: true,
                                plugins: {
                                    legend: { position: 'top' }
                                },
                                scales: {
                                    y: { 
                                        beginAtZero: true,
                                        max: 100
                                    }
                                }
                            }
                        })
                    }, 100)
                    
                } catch (error) {
                    console.error(error)
                    document.getElementById('user-details-content').innerHTML = \`
                        <div class="text-center py-12">
                            <i class="fas fa-exclamation-circle text-4xl text-red-600"></i>
                            <p class="text-gray-600 mt-4">Erro ao carregar dados do aluno</p>
                        </div>
                    \`
                }
            }

            function closeUserDetailsModal() {
                document.getElementById('modal-user-details').classList.add('hidden')
                currentUserData = null
            }

            function exportUserPDF() {
                if (!currentUserData) return
                
                const element = document.getElementById('user-details-content')
                const opt = {
                    margin: 10,
                    filename: \`relatorio_\${currentUserData.usuario.nome.replace(/ /g, '_')}_\${new Date().toISOString().split('T')[0]}.pdf\`,
                    image: { type: 'jpeg', quality: 0.98 },
                    html2canvas: { scale: 2 },
                    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
                }
                
                html2pdf().set(opt).from(element).save()
            }

            // Adicionar Tema
            function showAddTemaModal() {
                document.getElementById('modal-add-tema').classList.remove('hidden')
            }

            function closeAddTemaModal() {
                document.getElementById('modal-add-tema').classList.add('hidden')
                document.getElementById('form-add-tema').reset()
            }

            document.getElementById('form-add-tema').addEventListener('submit', async (e) => {
                e.preventDefault()
                
                const tema = {
                    tema: document.getElementById('add-tema').value,
                    area: document.getElementById('add-area').value,
                    subarea: document.getElementById('add-subarea').value,
                    subtopicos: document.getElementById('add-subtopicos').value,
                    prevalencia: document.getElementById('add-prevalencia').value,
                    prevalencia_numero: parseInt(document.getElementById('add-prevalencia-numero').value),
                    prioridade: document.getElementById('add-prioridade').value
                }

                try {
                    const res = await fetch('/api/admin/temas', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(tema)
                    })
                    const data = await res.json()

                    if (data.success) {
                        alert('✅ Tema adicionado com sucesso!')
                        closeAddTemaModal()
                        loadAdminTemas()
                        // Atualizar contador
                        loadAdminOverview()
                    } else {
                        alert('❌ Erro: ' + data.error)
                    }
                } catch (error) {
                    alert('❌ Erro ao conectar com servidor')
                }
            })

            // Editar Tema
            async function editTema(id) {
                try {
                    const res = await fetch(\`/api/admin/temas/\${id}\`)
                    const data = await res.json()
                    
                    if (data.tema) {
                        const t = data.tema
                        document.getElementById('edit-id').value = t.id
                        document.getElementById('edit-tema').value = t.tema
                        document.getElementById('edit-area').value = t.area
                        document.getElementById('edit-subarea').value = t.subarea
                        document.getElementById('edit-subtopicos').value = t.subtopicos || ''
                        document.getElementById('edit-prevalencia').value = t.prevalencia
                        document.getElementById('edit-prevalencia-numero').value = t.prevalencia_numero
                        document.getElementById('edit-prioridade').value = t.prioridade || ''
                        
                        document.getElementById('modal-edit-tema').classList.remove('hidden')
                    }
                } catch (error) {
                    alert('❌ Erro ao carregar tema')
                }
            }

            function closeEditTemaModal() {
                document.getElementById('modal-edit-tema').classList.add('hidden')
            }

            document.getElementById('form-edit-tema').addEventListener('submit', async (e) => {
                e.preventDefault()
                
                const id = document.getElementById('edit-id').value
                const tema = {
                    tema: document.getElementById('edit-tema').value,
                    area: document.getElementById('edit-area').value,
                    subarea: document.getElementById('edit-subarea').value,
                    subtopicos: document.getElementById('edit-subtopicos').value,
                    prevalencia: document.getElementById('edit-prevalencia').value,
                    prevalencia_numero: parseInt(document.getElementById('edit-prevalencia-numero').value),
                    prioridade: document.getElementById('edit-prioridade').value
                }

                try {
                    const res = await fetch(\`/api/admin/temas/\${id}\`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(tema)
                    })
                    const data = await res.json()

                    if (data.success) {
                        alert('✅ Tema atualizado com sucesso!')
                        closeEditTemaModal()
                        loadAdminTemas()
                    } else {
                        alert('❌ Erro: ' + data.error)
                    }
                } catch (error) {
                    alert('❌ Erro ao conectar com servidor')
                }
            })

            // Deletar Tema
            async function deleteTema(id, nome) {
                if (!confirm(\`Tem certeza que deseja excluir o tema "\${nome}"?\`)) return
                
                const res = await fetch(\`/api/admin/temas/\${id}\`, { method: 'DELETE' })
                const data = await res.json()
                
                if (data.success) {
                    alert('Tema excluído com sucesso!')
                    loadAdminTemas()
                } else {
                    alert('Erro: ' + data.error)
                }
            }

            function logout() {
                document.cookie = 'auth_token=; path=/; max-age=0'
                window.location.href = '/login'
            }

            // Load initial
            loadAdminOverview()
        </script>

        <!-- Footer -->
        <footer class="text-center py-6 mt-12 text-gray-600 text-sm">
            <p>Criado com muito <span class="text-red-500">❤️</span> por <strong>Erique Melo</strong> e muito ☕</p>
        </footer>
    </body>
    </html>
  `)
})

// ====================================================
// ADMIN: APIs
// ====================================================
app.get('/api/admin/stats', async (c) => {
  const auth = await requireAdmin(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const hoje = getDataISOBrasil()
  
  try {
    const stats = await DB.prepare(`
      SELECT 
        (SELECT COUNT(*) FROM usuarios) as total_usuarios,
        (SELECT COUNT(*) FROM temas) as total_temas,
        (SELECT COUNT(*) FROM estudos) as total_estudos,
        (SELECT COUNT(*) FROM estudos WHERE data_estudo = ?) as estudos_hoje,
        (SELECT COALESCE(SUM(questoes_feitas), 0) FROM estudos) as questoes_total,
        (SELECT COUNT(*) FROM revisoes WHERE concluida = 0) as revisoes_pendentes,
        (SELECT COUNT(DISTINCT usuario_id) FROM estudos WHERE data_estudo >= date('now', '-7 days')) as usuarios_ativos_7d,
        (SELECT COALESCE(AVG(acuracia), 0) FROM estudos WHERE acuracia > 0) as acuracia_media_geral,
        (SELECT COALESCE(SUM(tempo_minutos), 0) FROM estudos) as tempo_estudo_total,
        (SELECT COUNT(DISTINCT tema_id) FROM estudos) as temas_estudados,
        (SELECT COUNT(*) FROM revisoes WHERE concluida = 1) as revisoes_concluidas,
        (SELECT COUNT(*) FROM usuarios WHERE last_login >= date('now', '-30 days')) as usuarios_ativos_30d,
        (SELECT COUNT(*) FROM usuarios WHERE created_at >= date('now', '-7 days')) as novos_usuarios_7d
    `).bind(hoje).first()

    return c.json(stats)

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

app.get('/api/admin/usuarios', async (c) => {
  const auth = await requireAdmin(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  
  try {
    const usuarios = await DB.prepare(`
      SELECT id, email, nome, data_prova, is_admin, created_at, last_login
      FROM usuarios
      ORDER BY created_at DESC
    `).all()

    return c.json({ usuarios: usuarios.results })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

app.get('/api/admin/usuarios/:id', async (c) => {
  const auth = await requireAdmin(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const userId = c.req.param('id')
  
  try {
    const usuario = await DB.prepare('SELECT * FROM usuarios WHERE id = ?').bind(userId).first()
    const totalEstudos = await DB.prepare('SELECT COUNT(*) as total FROM estudos WHERE usuario_id = ?').bind(userId).first()
    const totalQuestoes = await DB.prepare('SELECT SUM(questoes_feitas) as total FROM estudos WHERE usuario_id = ?').bind(userId).first()

    return c.json({ 
      usuario, 
      total_estudos: totalEstudos?.total || 0,
      total_questoes: totalQuestoes?.total || 0
    })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

app.get('/api/admin/usuarios/:id/detalhes', async (c) => {
  const auth = await requireAdmin(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const userId = c.req.param('id')
  
  try {
    const usuario = await DB.prepare('SELECT * FROM usuarios WHERE id = ?').bind(userId).first()
    
    if (!usuario) {
      return c.json({ error: 'Usuário não encontrado' }, 404)
    }

    // Verificar se a tabela estudos existe
    const tableCheck = await DB.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='estudos'
    `).first()

    // Se não tem tabela, retornar dados vazios
    if (!tableCheck) {
      return c.json({
        usuario,
        stats: {
          total_estudos: 0,
          total_questoes: 0,
          tempo_total_minutos: 0,
          tempo_medio_minutos: 0,
          acuracia_media: 0,
          dias_estudo: 0,
          temas_estudados: 0,
          revisoes_pendentes: 0
        },
        por_area: [],
        evolucao: []
      })
    }

    // Estatísticas gerais
    const stats = await DB.prepare(`
      SELECT 
        COUNT(*) as total_estudos,
        COALESCE(SUM(questoes_feitas), 0) as total_questoes,
        COALESCE(SUM(tempo_minutos), 0) as tempo_total_minutos,
        COALESCE(AVG(tempo_minutos), 0) as tempo_medio_minutos,
        COALESCE(AVG(CASE WHEN acuracia > 0 THEN acuracia ELSE NULL END), 0) as acuracia_media,
        COUNT(DISTINCT data_estudo) as dias_estudo,
        COUNT(DISTINCT tema_id) as temas_estudados
      FROM estudos 
      WHERE usuario_id = ?
    `).bind(userId).first()

    // Revisões pendentes
    const revisoesPendentes = await DB.prepare(`
      SELECT COUNT(*) as count 
      FROM revisoes r
      INNER JOIN estudos e ON r.estudo_id = e.id
      WHERE e.usuario_id = ? AND r.concluida = 0
    `).bind(userId).first()

    // Performance por área
    const porArea = await DB.prepare(`
      SELECT 
        t.area,
        COUNT(e.id) as total_estudos,
        COALESCE(AVG(CASE WHEN e.acuracia > 0 THEN e.acuracia ELSE NULL END), 0) as acuracia,
        COALESCE(SUM(e.questoes_feitas), 0) as questoes
      FROM estudos e
      INNER JOIN temas t ON e.tema_id = t.id
      WHERE e.usuario_id = ?
      GROUP BY t.area
      ORDER BY acuracia DESC
    `).bind(userId).all()

    // Evolução temporal (últimos 30 dias)
    const evolucao = await DB.prepare(`
      SELECT 
        data_estudo as data,
        COALESCE(AVG(CASE WHEN acuracia > 0 THEN acuracia ELSE NULL END), 0) as acuracia,
        COUNT(*) as estudos
      FROM estudos 
      WHERE usuario_id = ? AND data_estudo >= date('now', '-30 days')
      GROUP BY data_estudo
      ORDER BY data_estudo ASC
    `).bind(userId).all()

    return c.json({
      usuario,
      stats: {
        ...stats,
        revisoes_pendentes: revisoesPendentes?.count || 0
      },
      por_area: porArea.results || [],
      evolucao: evolucao.results || []
    })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

app.get('/api/admin/temas', async (c) => {
  const auth = await requireAdmin(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  
  try {
    const temas = await DB.prepare(`
      SELECT * FROM temas
      ORDER BY prevalencia_numero DESC, area, tema
    `).all()

    return c.json({ temas: temas.results })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

app.get('/api/admin/temas/:id', async (c) => {
  const auth = await requireAdmin(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const temaId = c.req.param('id')
  
  try {
    const tema = await DB.prepare('SELECT * FROM temas WHERE id = ?').bind(temaId).first()
    
    if (!tema) {
      return c.json({ error: 'Tema não encontrado' }, 404)
    }

    return c.json({ tema })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

app.post('/api/admin/temas', async (c) => {
  const auth = await requireAdmin(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  
  try {
    const { tema, area, subarea, subtopicos, prevalencia, prevalencia_numero, prioridade } = await c.req.json()

    if (!tema || !area || !subarea || !prevalencia || !prevalencia_numero) {
      return c.json({ error: 'Campos obrigatórios faltando' }, 400)
    }

    await DB.prepare(`
      INSERT INTO temas (tema, area, subarea, subtopicos, prevalencia, prevalencia_numero, prioridade)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(tema, area, subarea, subtopicos, prevalencia, prevalencia_numero, prioridade).run()

    return c.json({ success: true })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

app.put('/api/admin/temas/:id', async (c) => {
  const auth = await requireAdmin(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const temaId = c.req.param('id')
  
  try {
    const { tema, area, subarea, subtopicos, prevalencia, prevalencia_numero, prioridade } = await c.req.json()

    if (!tema || !area || !subarea || !prevalencia || !prevalencia_numero) {
      return c.json({ error: 'Campos obrigatórios faltando' }, 400)
    }

    await DB.prepare(`
      UPDATE temas 
      SET tema = ?, area = ?, subarea = ?, subtopicos = ?, prevalencia = ?, prevalencia_numero = ?, prioridade = ?
      WHERE id = ?
    `).bind(tema, area, subarea, subtopicos, prevalencia, prevalencia_numero, prioridade, temaId).run()

    return c.json({ success: true })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

app.delete('/api/admin/temas/:id', async (c) => {
  const auth = await requireAdmin(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const temaId = c.req.param('id')
  
  try {
    await DB.prepare('DELETE FROM temas WHERE id = ?').bind(temaId).run()
    return c.json({ success: true })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// ====================================================
// CICLO DE ESTUDOS ADAPTATIVOS
// ====================================================

// Função auxiliar: calcular semanas entre duas datas
function calcularSemanas(dataInicio: Date, dataFim: Date): number {
  const diffTime = Math.abs(dataFim.getTime() - dataInicio.getTime())
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
  return Math.floor(diffDays / 7)
}

// Função auxiliar: calcular distribuição de temas por tipo de ciclo
function calcularDistribuicaoTemas(tipoCiclo: string, semanasReais: number, temas: any[]) {
  const temasAlta = temas.filter(t => t.prevalencia_numero === 5)
  const temasMedia = temas.filter(t => t.prevalencia_numero === 3)
  const temasBaixa = temas.filter(t => t.prevalencia_numero === 1)

  let temasDistribuir: any[] = []
  let mensagemAlerta = ''

  if (tipoCiclo === 'extensivo') {
    // Extensivo: todos os temas (Alta + Média + Baixa)
    temasDistribuir = [...temasAlta, ...temasMedia, ...temasBaixa]
    mensagemAlerta = semanasReais < 40 
      ? `Ciclo Extensivo adaptado para ${semanasReais} semanas. Cobertura completa mantida com maior densidade.`
      : `Ciclo Extensivo de ${semanasReais} semanas gerado com sucesso!`
  } else if (tipoCiclo === 'semi-intensivo') {
    // Semi-intensivo: Alta + Média
    temasDistribuir = [...temasAlta, ...temasMedia]
    mensagemAlerta = semanasReais < 20
      ? `Ciclo Semi-intensivo adaptado para ${semanasReais} semanas. Foco em Alta e Média prevalência.`
      : `Ciclo Semi-intensivo de ${semanasReais} semanas gerado com sucesso!`
  } else if (tipoCiclo === 'intensivo') {
    // Intensivo: Alta prevalência + parte de Média (proporcional ao tempo)
    const percentualMedia = Math.min(1, semanasReais / 10) // até 100% de média em 10 semanas
    const quantidadeMedia = Math.floor(temasMedia.length * percentualMedia)
    temasDistribuir = [...temasAlta, ...temasMedia.slice(0, quantidadeMedia)]
    
    if (semanasReais < 6) {
      mensagemAlerta = `⚠️ ATENÇÃO: Apenas ${semanasReais} semanas até a prova! Foco MÁXIMO em temas de Alta prevalência.`
    } else if (semanasReais < 10) {
      mensagemAlerta = `Ciclo Intensivo de ${semanasReais} semanas. Cobertura de Alta prevalência + ${quantidadeMedia} temas de Média.`
    } else {
      mensagemAlerta = `Ciclo Intensivo de ${semanasReais} semanas gerado com sucesso!`
    }
  }

  // Distribuir temas por área de forma balanceada
  const temasOrdenados = temasDistribuir.sort((a, b) => {
    if (a.prevalencia_numero !== b.prevalencia_numero) {
      return b.prevalencia_numero - a.prevalencia_numero // Alta primeiro
    }
    return a.area.localeCompare(b.area) // Depois por área
  })

  return {
    temas: temasOrdenados,
    alta: temasAlta.filter(t => temasOrdenados.includes(t)).length,
    media: temasMedia.filter(t => temasOrdenados.includes(t)).length,
    baixa: temasBaixa.filter(t => temasOrdenados.includes(t)).length,
    mensagem: mensagemAlerta
  }
}

// API: Obter ciclo atual do usuário
app.get('/api/ciclo', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const usuarioId = auth.usuario.usuario_id

  try {
    const cicloAtivo = await DB.prepare(`
      SELECT * FROM ciclos_estudo 
      WHERE usuario_id = ? AND status = 'ativo'
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(usuarioId).first()

    if (!cicloAtivo) {
      return c.json({ ciclo: null })
    }

    // Buscar semanas do ciclo
    const semanas = await DB.prepare(`
      SELECT * FROM ciclo_semanas
      WHERE ciclo_id = ?
      ORDER BY numero_semana ASC
    `).bind(cicloAtivo.id).all()

    // Para cada semana, buscar os temas
    const semanasComTemas = await Promise.all(
      (semanas.results || []).map(async (semana: any) => {
        const temas = await DB.prepare(`
          SELECT cst.*, t.tema, t.area, t.subarea, t.prevalencia
          FROM ciclo_semana_temas cst
          INNER JOIN temas t ON cst.tema_id = t.id
          WHERE cst.ciclo_semana_id = ?
          ORDER BY cst.ordem ASC
        `).bind(semana.id).all()

        return {
          ...semana,
          temas: temas.results || []
        }
      })
    )

    return c.json({
      ciclo: cicloAtivo,
      semanas: semanasComTemas
    })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// API: Gerar novo ciclo de estudos
app.post('/api/ciclo/gerar', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const usuarioId = auth.usuario.usuario_id

  try {
    const { tipo_ciclo } = await c.req.json()

    if (!tipo_ciclo || !['extensivo', 'semi-intensivo', 'intensivo'].includes(tipo_ciclo)) {
      return c.json({ error: 'Tipo de ciclo inválido' }, 400)
    }

    // Buscar data da prova do usuário
    const usuario = await DB.prepare('SELECT data_prova FROM usuarios WHERE id = ?').bind(usuarioId).first()

    if (!usuario || !usuario.data_prova) {
      return c.json({ error: 'Data da prova não definida. Configure a data da prova primeiro.' }, 400)
    }

    const hoje = new Date()
    const dataProva = new Date(usuario.data_prova)

    // Calcular semanas disponíveis
    const semanasDisponiveis = calcularSemanas(hoje, dataProva)

    if (semanasDisponiveis < 1) {
      return c.json({ error: 'A data da prova já passou ou é muito próxima (menos de 1 semana).' }, 400)
    }

    // Definir semanas planejadas padrão por tipo
    const semanasPadrao = {
      'extensivo': 40,
      'semi-intensivo': 20,
      'intensivo': 10
    }

    const semanasPlanejadas = semanasPadrao[tipo_ciclo as keyof typeof semanasPadrao]
    const semanasReais = Math.min(semanasDisponiveis, semanasPlanejadas)

    // Buscar todos os temas
    const todosTemas = await DB.prepare(`
      SELECT * FROM temas
      ORDER BY prevalencia_numero DESC, area, tema
    `).all()

    // Calcular distribuição de temas
    const distribuicao = calcularDistribuicaoTemas(tipo_ciclo, semanasReais, todosTemas.results || [])

    // Cancelar ciclo anterior se existir
    await DB.prepare(`
      UPDATE ciclos_estudo 
      SET status = 'cancelado'
      WHERE usuario_id = ? AND status = 'ativo'
    `).bind(usuarioId).run()

    // Criar novo ciclo
    const resultCiclo = await DB.prepare(`
      INSERT INTO ciclos_estudo (
        usuario_id, tipo_ciclo, semanas_planejadas, semanas_reais,
        data_inicio, data_prova, temas_alta, temas_media, temas_baixa,
        mensagem_alerta, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ativo')
    `).bind(
      usuarioId, tipo_ciclo, semanasPlanejadas, semanasReais,
      hoje.toISOString().split('T')[0], usuario.data_prova,
      distribuicao.alta, distribuicao.media, distribuicao.baixa,
      distribuicao.mensagem
    ).run()

    const cicloId = resultCiclo.meta.last_row_id

    // Distribuir temas pelas semanas
    const temasPorSemana = Math.ceil(distribuicao.temas.length / semanasReais)

    for (let numSemana = 1; numSemana <= semanasReais; numSemana++) {
      const dataInicioSemana = new Date(hoje)
      dataInicioSemana.setDate(hoje.getDate() + (numSemana - 1) * 7)
      
      const dataFimSemana = new Date(dataInicioSemana)
      dataFimSemana.setDate(dataInicioSemana.getDate() + 6)

      // Criar semana
      const resultSemana = await DB.prepare(`
        INSERT INTO ciclo_semanas (
          ciclo_id, numero_semana, data_inicio, data_fim
        ) VALUES (?, ?, ?, ?)
      `).bind(
        cicloId, numSemana,
        dataInicioSemana.toISOString().split('T')[0],
        dataFimSemana.toISOString().split('T')[0]
      ).run()

      const semanaId = resultSemana.meta.last_row_id

      // Selecionar temas para esta semana
      const indiceInicio = (numSemana - 1) * temasPorSemana
      const indiceFim = Math.min(indiceInicio + temasPorSemana, distribuicao.temas.length)
      const temasSemana = distribuicao.temas.slice(indiceInicio, indiceFim)

      // Inserir temas da semana
      for (let ordem = 0; ordem < temasSemana.length; ordem++) {
        await DB.prepare(`
          INSERT INTO ciclo_semana_temas (
            ciclo_semana_id, tema_id, ordem
          ) VALUES (?, ?, ?)
        `).bind(semanaId, temasSemana[ordem].id, ordem + 1).run()
      }

      // Atualizar contador de temas planejados na semana
      await DB.prepare(`
        UPDATE ciclo_semanas
        SET temas_planejados = ?
        WHERE id = ?
      `).bind(temasSemana.length, semanaId).run()
    }

    return c.json({
      success: true,
      ciclo_id: cicloId,
      mensagem: distribuicao.mensagem,
      estatisticas: {
        tipo_ciclo,
        semanas_planejadas: semanasPlanejadas,
        semanas_reais: semanasReais,
        total_temas: distribuicao.temas.length,
        temas_alta: distribuicao.alta,
        temas_media: distribuicao.media,
        temas_baixa: distribuicao.baixa,
        temas_por_semana: temasPorSemana
      }
    })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// API: Cancelar/Pausar ciclo atual
app.post('/api/ciclo/:acao', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const usuarioId = auth.usuario.usuario_id
  const acao = c.req.param('acao')

  if (!['pausar', 'cancelar', 'reativar'].includes(acao)) {
    return c.json({ error: 'Ação inválida' }, 400)
  }

  try {
    const novoStatus = acao === 'pausar' ? 'pausado' : acao === 'cancelar' ? 'cancelado' : 'ativo'

    await DB.prepare(`
      UPDATE ciclos_estudo
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE usuario_id = ? AND status IN ('ativo', 'pausado')
    `).bind(novoStatus, usuarioId).run()

    return c.json({ success: true, novo_status: novoStatus })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

export default app
