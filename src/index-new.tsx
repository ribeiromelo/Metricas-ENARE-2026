import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'

// Types
type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

// CORS
app.use('/api/*', cors())

// ====================================================
// FUNÇÕES DE AUTENTICAÇÃO
// ====================================================
function hashPassword(password: string): string {
  let hash = 0
  for (let i = 0; i < password.length; i++) {
    const char = password.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(36)
}

function generateToken(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36)
}

async function getUsuarioFromToken(DB: D1Database, token: string) {
  if (!token) return null

  const sessao = await DB.prepare(`
    SELECT s.*, u.id as usuario_id, u.email, u.nome, u.data_prova
    FROM sessoes s
    INNER JOIN usuarios u ON s.usuario_id = u.id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).bind(token).first()

  return sessao
}

// ====================================================
// API: CADASTRO
// ====================================================
app.post('/api/auth/cadastro', async (c) => {
  const { DB } = c.env
  
  try {
    const body = await c.req.json()
    const { email, senha, nome, data_prova } = body

    if (!email || !senha || !nome) {
      return c.json({ error: 'Email, senha e nome são obrigatórios' }, 400)
    }

    // Verificar se email já existe
    const existente = await DB.prepare('SELECT id FROM usuarios WHERE email = ?').bind(email).first()
    if (existente) {
      return c.json({ error: 'Email já cadastrado' }, 400)
    }

    // Criar usuário
    const senhaHash = hashPassword(senha)
    const usuarioResult = await DB.prepare(`
      INSERT INTO usuarios (email, senha_hash, nome, data_prova)
      VALUES (?, ?, ?, ?)
    `).bind(email, senhaHash, nome, data_prova || null).run()

    const usuarioId = usuarioResult.meta.last_row_id

    // Criar metas padrão
    await DB.prepare(`
      INSERT INTO metas_estudo (usuario_id, meta_ideal_horas, meta_realista_horas, meta_sobrevivencia_horas)
      VALUES (?, 4, 3, 2)
    `).bind(usuarioId).run()

    // Criar configuração
    await DB.prepare(`
      INSERT INTO configuracoes (usuario_id, horas_por_dia, temas_por_dia, data_prova)
      VALUES (?, 4, 4, ?)
    `).bind(usuarioId, data_prova || null).run()

    // Criar sessão
    const token = generateToken()
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

    await DB.prepare(`
      INSERT INTO sessoes (usuario_id, token, expires_at)
      VALUES (?, ?, ?)
    `).bind(usuarioId, token, expiresAt).run()

    setCookie(c, 'auth_token', token, {
      maxAge: 30 * 24 * 60 * 60,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
      path: '/'
    })

    return c.json({
      success: true,
      token,
      usuario: { id: usuarioId, email, nome }
    })

  } catch (error: any) {
    console.error('Erro no cadastro:', error)
    return c.json({ error: error.message }, 500)
  }
})

// ====================================================
// API: LOGIN
// ====================================================
app.post('/api/auth/login', async (c) => {
  const { DB } = c.env
  
  try {
    const body = await c.req.json()
    const { email, senha } = body

    if (!email || !senha) {
      return c.json({ error: 'Email e senha são obrigatórios' }, 400)
    }

    const senhaHash = hashPassword(senha)

    const usuario = await DB.prepare(`
      SELECT id, email, nome, data_prova
      FROM usuarios
      WHERE email = ? AND senha_hash = ?
    `).bind(email, senhaHash).first()

    if (!usuario) {
      return c.json({ error: 'Email ou senha incorretos' }, 401)
    }

    // Criar nova sessão
    const token = generateToken()
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

    await DB.prepare(`
      INSERT INTO sessoes (usuario_id, token, expires_at)
      VALUES (?, ?, ?)
    `).bind(usuario.id, token, expiresAt).run()

    setCookie(c, 'auth_token', token, {
      maxAge: 30 * 24 * 60 * 60,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
      path: '/'
    })

    return c.json({
      success: true,
      token,
      usuario
    })

  } catch (error: any) {
    console.error('Erro no login:', error)
    return c.json({ error: error.message }, 500)
  }
})

// ====================================================
// API: LOGOUT
// ====================================================
app.post('/api/auth/logout', async (c) => {
  const { DB } = c.env
  const token = getCookie(c, 'auth_token')

  if (token) {
    await DB.prepare('DELETE FROM sessoes WHERE token = ?').bind(token).run()
  }

  deleteCookie(c, 'auth_token', { path: '/' })

  return c.json({ success: true })
})

// ====================================================
// API: USUÁRIO ATUAL
// ====================================================
app.get('/api/auth/me', async (c) => {
  const { DB } = c.env
  const token = getCookie(c, 'auth_token')

  if (!token) {
    return c.json({ error: 'Não autenticado' }, 401)
  }

  const usuario = await getUsuarioFromToken(DB, token)

  if (!usuario) {
    return c.json({ error: 'Sessão inválida' }, 401)
  }

  return c.json({
    usuario: {
      id: usuario.usuario_id,
      email: usuario.email,
      nome: usuario.nome,
      data_prova: usuario.data_prova
    }
  })
})

// ====================================================
// MIDDLEWARE: VERIFICAR AUTENTICAÇÃO
// ====================================================
async function requireAuth(c: any) {
  const token = getCookie(c, 'auth_token')

  if (!token) {
    return { error: 'Não autenticado', status: 401 }
  }

  const usuario = await getUsuarioFromToken(c.env.DB, token)
  
  if (!usuario) {
    return { error: 'Sessão inválida', status: 401 }
  }

  return { usuario }
}

// ====================================================
// API: GERADOR DE CICLO (COM AUTH)
// ====================================================
app.post('/api/ciclo/gerar', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const usuarioId = auth.usuario.usuario_id
  
  try {
    // Verificar se já existe ciclo
    const configResult = await DB.prepare(`
      SELECT ciclo_gerado FROM configuracoes WHERE usuario_id = ?
    `).bind(usuarioId).first()
    
    if (configResult && configResult.ciclo_gerado) {
      return c.json({ error: 'Ciclo já foi gerado para este usuário' }, 400)
    }

    // Buscar metas do usuário
    const metas = await DB.prepare('SELECT * FROM metas_estudo WHERE usuario_id = ?').bind(usuarioId).first()
    const temasPorSemana = metas?.meta_ideal_temas || 4

    // Buscar todos os temas
    const temasResult = await DB.prepare(`
      SELECT * FROM temas 
      ORDER BY prevalencia_numero DESC, area, id
    `).all()

    const temas = temasResult.results as any[]
    
    if (temas.length === 0) {
      return c.json({ error: 'Nenhum tema encontrado' }, 400)
    }

    // Agrupar por área
    const temasPorArea: { [key: string]: any[] } = {}
    temas.forEach(tema => {
      if (!temasPorArea[tema.area]) {
        temasPorArea[tema.area] = []
      }
      temasPorArea[tema.area].push(tema)
    })

    // Gerar 40 semanas
    const NUMERO_SEMANAS = 40
    const semanasGeradas: Array<{ semana: number, temas: any[] }> = []
    
    const indices: { [key: string]: number } = {}
    Object.keys(temasPorArea).forEach(area => {
      indices[area] = 0
    })

    const areas = Object.keys(temasPorArea)
    let areaIndex = 0

    for (let semana = 1; semana <= NUMERO_SEMANAS; semana++) {
      const temasDaSemana: any[] = []
      
      for (let i = 0; i < temasPorSemana; i++) {
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

        if (tentativas >= areas.length) break
      }

      if (temasDaSemana.length > 0) {
        semanasGeradas.push({ semana, temas: temasDaSemana })
      }
    }

    // Inserir no banco
    const hoje = new Date().toISOString().split('T')[0]
    
    for (const sg of semanasGeradas) {
      const semanaResult = await DB.prepare(`
        INSERT INTO semanas (numero_semana, data_inicio, data_fim, usuario_id) 
        VALUES (?, ?, ?, ?)
      `).bind(sg.semana, hoje, hoje, usuarioId).run()

      const semanaId = semanaResult.meta.last_row_id

      for (let i = 0; i < sg.temas.length; i++) {
        const tema = sg.temas[i]
        const metodo = ['Clínica Médica', 'Cirurgia Geral', 'Obstetrícia', 'Ginecologia'].includes(tema.area) ? 'questoes' : 'teoria'
        
        await DB.prepare(`
          INSERT INTO semana_temas (semana_id, tema_id, ordem, metodo, meta_questoes, meta_tempo_minutos)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(semanaId, tema.id, i + 1, metodo, 15, 60).run()
      }
    }

    // Atualizar configuração
    await DB.prepare('UPDATE configuracoes SET ciclo_gerado = 1 WHERE usuario_id = ?').bind(usuarioId).run()

    return c.json({ 
      success: true, 
      message: `Ciclo de ${semanasGeradas.length} semanas gerado com sucesso`,
      semanas: semanasGeradas.length,
      temas_distribuidos: semanasGeradas.reduce((acc, s) => acc + s.temas.length, 0)
    })

  } catch (error: any) {
    console.error('Erro ao gerar ciclo:', error)
    return c.json({ error: error.message }, 500)
  }
})

// ====================================================
// API: SEMANA ATUAL (COM AUTH)
// ====================================================
app.get('/api/semana/atual', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const usuarioId = auth.usuario.usuario_id
  
  try {
    const config = await DB.prepare(`
      SELECT semana_atual FROM configuracoes WHERE usuario_id = ?
    `).bind(usuarioId).first()
    
    const semanaAtual = config?.semana_atual || 1

    const semana = await DB.prepare(`
      SELECT * FROM semanas WHERE numero_semana = ? AND usuario_id = ?
    `).bind(semanaAtual, usuarioId).first()

    if (!semana) {
      return c.json({ error: 'Semana não encontrada. Gere o ciclo primeiro!' }, 404)
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
    console.error('Erro ao buscar semana:', error)
    return c.json({ error: error.message }, 500)
  }
})

// ====================================================
// API: REGISTRAR ESTUDO (COM AUTH)
// ====================================================
app.post('/api/estudo/registrar', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const usuarioId = auth.usuario.usuario_id
  
  try {
    const body = await c.req.json()
    const { tema_id, semana_tema_id, metodo, questoes_feitas, questoes_acertos, tempo_minutos } = body

    if (!tema_id || !metodo) {
      return c.json({ error: 'tema_id e metodo são obrigatórios' }, 400)
    }

    const acuracia = questoes_feitas > 0 ? (questoes_acertos / questoes_feitas) * 100 : 0
    const hoje = new Date().toISOString().split('T')[0]

    const estudoResult = await DB.prepare(`
      INSERT INTO estudos (tema_id, semana_tema_id, data_estudo, metodo, questoes_feitas, questoes_acertos, acuracia, tempo_minutos, usuario_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(tema_id, semana_tema_id || null, hoje, metodo, questoes_feitas || 0, questoes_acertos || 0, acuracia, tempo_minutos || 0, usuarioId).run()

    const estudoId = estudoResult.meta.last_row_id

    // Sistema de revisões
    const tema = await DB.prepare('SELECT prevalencia_numero FROM temas WHERE id = ?').bind(tema_id).first()
    const intervalos = calcularIntervalos(tema?.prevalencia_numero || 3, acuracia)

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
    console.error('Erro ao registrar estudo:', error)
    return c.json({ error: error.message }, 500)
  }
})

function calcularIntervalos(prevalencia: number, acuracia: number): number[] {
  let intervalos = [1, 3, 7, 15, 30, 60]

  if (prevalencia === 5) {
    intervalos = intervalos.map(i => Math.floor(i * 0.7))
  } else if (prevalencia === 1) {
    intervalos = intervalos.map(i => Math.floor(i * 1.3))
  }

  if (acuracia < 70) {
    intervalos = intervalos.map(i => Math.max(1, Math.floor(i * 0.6)))
  } else if (acuracia > 85) {
    intervalos = intervalos.map(i => Math.floor(i * 1.4))
  }

  return intervalos
}

// Adicionar outras APIs (revisões, métricas, etc) com requireAuth...
app.get('/api/revisoes/pendentes', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const usuarioId = auth.usuario.usuario_id
  const hoje = new Date().toISOString().split('T')[0]

  const revisoesResult = await DB.prepare(`
    SELECT r.*, t.tema, t.area, t.prevalencia
    FROM revisoes r
    INNER JOIN estudos e ON r.estudo_id = e.id
    INNER JOIN temas t ON r.tema_id = t.id
    WHERE e.usuario_id = ? AND r.concluida = 0 AND r.data_agendada <= ?
    ORDER BY r.data_agendada ASC
    LIMIT 20
  `).bind(usuarioId, hoje).all()

  return c.json({ revisoes: revisoesResult.results })
})

app.post('/api/revisao/concluir', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const usuarioId = auth.usuario.usuario_id

  try {
    const body = await c.req.json()
    const { id, acuracia_revisao } = body

    if (!id) {
      return c.json({ error: 'ID da revisão é obrigatório' }, 400)
    }

    // Verificar se a revisão pertence ao usuário
    const revisao = await DB.prepare(`
      SELECT r.* FROM revisoes r
      INNER JOIN estudos e ON r.estudo_id = e.id
      WHERE r.id = ? AND e.usuario_id = ?
    `).bind(id, usuarioId).first()

    if (!revisao) {
      return c.json({ error: 'Revisão não encontrada ou não pertence a você' }, 404)
    }

    const hoje = new Date().toISOString().split('T')[0]
    await DB.prepare(`
      UPDATE revisoes SET concluida = 1, data_concluida = ?, acuracia_revisao = ?
      WHERE id = ?
    `).bind(hoje, acuracia_revisao || null, id).run()

    return c.json({ success: true })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

app.get('/api/semanas', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const usuarioId = auth.usuario.usuario_id

  try {
    const semanasResult = await DB.prepare(`
      SELECT s.*, COUNT(st.id) as total_temas
      FROM semanas s
      LEFT JOIN semana_temas st ON s.id = st.semana_id
      WHERE s.usuario_id = ?
      GROUP BY s.id
      ORDER BY s.numero_semana ASC
    `).bind(usuarioId).all()

    return c.json({ semanas: semanasResult.results })
  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

app.get('/api/metricas', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return c.json({ error: auth.error }, auth.status)

  const { DB } = c.env
  const usuarioId = auth.usuario.usuario_id

  const totalEstudos = await DB.prepare('SELECT COUNT(*) as total FROM estudos WHERE usuario_id = ?').bind(usuarioId).first()
  const totalQuestoes = await DB.prepare('SELECT SUM(questoes_feitas) as total FROM estudos WHERE usuario_id = ?').bind(usuarioId).first()
  const acuraciaMedia = await DB.prepare('SELECT AVG(acuracia) as media FROM estudos WHERE acuracia > 0 AND usuario_id = ?').bind(usuarioId).first()

  const acuraciaPorArea = await DB.prepare(`
    SELECT t.area, AVG(e.acuracia) as media_acuracia, COUNT(e.id) as total_estudos
    FROM estudos e
    INNER JOIN temas t ON e.tema_id = t.id
    WHERE e.acuracia > 0 AND e.usuario_id = ?
    GROUP BY t.area
    ORDER BY media_acuracia ASC
  `).bind(usuarioId).all()

  const temasMaisErrados = await DB.prepare(`
    SELECT t.tema, t.area, AVG(e.acuracia) as media_acuracia
    FROM estudos e
    INNER JOIN temas t ON e.tema_id = t.id
    WHERE e.acuracia > 0 AND e.usuario_id = ?
    GROUP BY e.tema_id
    HAVING AVG(e.acuracia) < 70
    ORDER BY media_acuracia ASC
    LIMIT 10
  `).bind(usuarioId).all()

  const hoje = new Date().toISOString().split('T')[0]
  const revisoesPendentes = await DB.prepare(`
    SELECT COUNT(*) as total FROM revisoes r
    INNER JOIN estudos e ON r.estudo_id = e.id
    WHERE e.usuario_id = ? AND r.concluida = 0 AND r.data_agendada <= ?
  `).bind(usuarioId, hoje).first()

  return c.json({
    total_estudos: totalEstudos?.total || 0,
    total_questoes: totalQuestoes?.total || 0,
    acuracia_media: acuraciaMedia?.media || 0,
    acuracia_por_area: acuraciaPorArea.results,
    temas_mais_errados: temasMaisErrados.results,
    revisoes_pendentes: revisoesPendentes?.total || 0
  })
})

// ====================================================
// PÁGINA DE LOGIN
// ====================================================
app.get('/login', (c) => {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login - Cérebro HardMed</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gradient-to-br from-blue-50 to-indigo-100 min-h-screen flex items-center justify-center p-4">
    <div class="max-w-md w-full">
        <div class="bg-white rounded-2xl shadow-2xl p-8">
            <div class="text-center mb-8">
                <div class="inline-block bg-indigo-600 p-4 rounded-full mb-4">
                    <svg class="w-12 h-12 text-white" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M10.394 2.08a1 1 0 00-.788 0l-7 3a1 1 0 000 1.84L5.25 8.051a.999.999 0 01.356-.257l4-1.714a1 1 0 11.788 1.838L7.667 9.088l1.94.831a1 1 0 00.787 0l7-3a1 1 0 000-1.838l-7-3zM3.31 9.397L5 10.12v4.102a8.969 8.969 0 00-1.05-.174 1 1 0 01-.89-.89 11.115 11.115 0 01.25-3.762zM9.3 16.573A9.026 9.026 0 007 14.935v-3.957l1.818.78a3 3 0 002.364 0l5.508-2.361a11.026 11.026 0 01.25 3.762 1 1 0 01-.89.89 8.968 8.968 0 00-5.35 2.524 1 1 0 01-1.4 0zM6 18a1 1 0 001-1v-2.065a8.935 8.935 0 00-2-.712V17a1 1 0 001 1z"/>
                    </svg>
                </div>
                <h1 class="text-3xl font-bold text-gray-800 mb-2">Cérebro HardMed</h1>
                <p class="text-gray-600">Sistema de Estudos ENARE 2026</p>
            </div>

            <div class="flex mb-6 bg-gray-100 rounded-lg p-1">
                <button onclick="showTab('login')" id="btn-login" class="flex-1 py-2 px-4 rounded-md bg-white shadow text-indigo-600 font-semibold transition">
                    Entrar
                </button>
                <button onclick="showTab('cadastro')" id="btn-cadastro" class="flex-1 py-2 px-4 rounded-md text-gray-600 font-semibold transition hover:text-indigo-600">
                    Criar Conta
                </button>
            </div>

            <form id="form-login" onsubmit="handleLogin(event)">
                <div class="space-y-4">
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">Email</label>
                        <input type="email" id="login-email" required 
                            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">Senha</label>
                        <input type="password" id="login-senha" required 
                            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent">
                    </div>
                    <button type="submit" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-3 rounded-lg transition">
                        Entrar
                    </button>
                </div>
            </form>

            <form id="form-cadastro" onsubmit="handleCadastro(event)" class="hidden">
                <div class="space-y-4">
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">Nome Completo</label>
                        <input type="text" id="cadastro-nome" required 
                            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">Email</label>
                        <input type="email" id="cadastro-email" required 
                            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">Senha (mínimo 6 caracteres)</label>
                        <input type="password" id="cadastro-senha" required minlength="6"
                            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">Data da Prova (opcional)</label>
                        <input type="date" id="cadastro-data-prova" 
                            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent">
                    </div>
                    <button type="submit" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-3 rounded-lg transition">
                        Criar Conta
                    </button>
                </div>
            </form>

            <div id="message" class="mt-4 text-center text-sm"></div>
        </div>
    </div>

    <script>
    function showTab(tab) {
        const formLogin = document.getElementById('form-login')
        const formCadastro = document.getElementById('form-cadastro')
        const btnLogin = document.getElementById('btn-login')
        const btnCadastro = document.getElementById('btn-cadastro')

        if (tab === 'login') {
            formLogin.classList.remove('hidden')
            formCadastro.classList.add('hidden')
            btnLogin.classList.add('bg-white', 'shadow', 'text-indigo-600')
            btnLogin.classList.remove('text-gray-600')
            btnCadastro.classList.remove('bg-white', 'shadow', 'text-indigo-600')
            btnCadastro.classList.add('text-gray-600')
        } else {
            formCadastro.classList.remove('hidden')
            formLogin.classList.add('hidden')
            btnCadastro.classList.add('bg-white', 'shadow', 'text-indigo-600')
            btnCadastro.classList.remove('text-gray-600')
            btnLogin.classList.remove('bg-white', 'shadow', 'text-indigo-600')
            btnLogin.classList.add('text-gray-600')
        }
    }

    async function handleLogin(e) {
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
                showMessage('Login realizado! Redirecionando...', 'success')
                setTimeout(() => window.location.href = '/', 1000)
            } else {
                showMessage(data.error || 'Erro ao fazer login', 'error')
            }
        } catch (error) {
            showMessage('Erro ao conectar com o servidor', 'error')
        }
    }

    async function handleCadastro(e) {
        e.preventDefault()
        const nome = document.getElementById('cadastro-nome').value
        const email = document.getElementById('cadastro-email').value
        const senha = document.getElementById('cadastro-senha').value
        const data_prova = document.getElementById('cadastro-data-prova').value

        try {
            const res = await fetch('/api/auth/cadastro', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nome, email, senha, data_prova })
            })

            const data = await res.json()

            if (data.success) {
                showMessage('Conta criada! Redirecionando...', 'success')
                setTimeout(() => window.location.href = '/', 1000)
            } else {
                showMessage(data.error || 'Erro ao criar conta', 'error')
            }
        } catch (error) {
            showMessage('Erro ao conectar com o servidor', 'error')
        }
    }

    function showMessage(msg, type) {
        const el = document.getElementById('message')
        el.textContent = msg
        el.className = 'mt-4 text-center text-sm font-medium ' + (type === 'error' ? 'text-red-600' : 'text-green-600')
    }
    </script>
</body>
</html>`
  
  return c.html(html)
})

// ====================================================
// PÁGINA PRINCIPAL (COM VERIFICAÇÃO DE LOGIN)
// ====================================================
app.get('/', async (c) => {
  const { DB } = c.env
  const token = getCookie(c, 'auth_token')
  
  if (!token) {
    return c.redirect('/login')
  }

  const usuario = await getUsuarioFromToken(DB, token)
  
  if (!usuario) {
    return c.redirect('/login')
  }

  const html = `<!DOCTYPE html>
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
                        <h1 class="text-3xl font-bold text-gray-800">Cérebro HardMed</h1>
                        <p class="text-gray-600">Olá, ${usuario.nome}!</p>
                    </div>
                </div>
                <button onclick="logout()" class="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-lg">
                    <i class="fas fa-sign-out-alt mr-2"></i>Sair
                </button>
            </div>
        </div>
    </header>

    <!-- Main Content -->
    <div class="max-w-7xl mx-auto px-4 py-8">
        <!-- Tabs -->
        <div class="flex space-x-2 mb-6 overflow-x-auto">
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
                <i class="fas fa-chart-line mr-2"></i>Métricas
            </button>
        </div>

        <!-- Tab: Dashboard -->
        <div id="tab-dashboard" class="tab-content">
            <!-- Cards de Métricas -->
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <div class="bg-white rounded-lg shadow-lg p-6 border-t-4 border-indigo-600">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-gray-600 text-sm font-semibold">Total Estudos</p>
                            <p class="text-3xl font-bold text-indigo-600" id="total-estudos">0</p>
                        </div>
                        <i class="fas fa-book-open text-4xl text-indigo-200"></i>
                    </div>
                </div>
                <div class="bg-white rounded-lg shadow-lg p-6 border-t-4 border-green-600">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-gray-600 text-sm font-semibold">Questões Feitas</p>
                            <p class="text-3xl font-bold text-green-600" id="total-questoes">0</p>
                        </div>
                        <i class="fas fa-clipboard-check text-4xl text-green-200"></i>
                    </div>
                </div>
                <div class="bg-white rounded-lg shadow-lg p-6 border-t-4 border-blue-600">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-gray-600 text-sm font-semibold">Acurácia Média</p>
                            <p class="text-3xl font-bold text-blue-600" id="acuracia-media">0%</p>
                        </div>
                        <i class="fas fa-bullseye text-4xl text-blue-200"></i>
                    </div>
                </div>
                <div class="bg-white rounded-lg shadow-lg p-6 border-t-4 border-orange-600">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-gray-600 text-sm font-semibold">Revisões Pendentes</p>
                            <p class="text-3xl font-bold text-orange-600" id="revisoes-pendentes">0</p>
                        </div>
                        <i class="fas fa-redo text-4xl text-orange-200"></i>
                    </div>
                </div>
            </div>

            <!-- Gerador de Ciclo -->
            <div id="gerador-ciclo" class="bg-gradient-to-r from-indigo-500 to-purple-600 rounded-lg shadow-lg p-8 mb-6 text-white">
                <h2 class="text-2xl font-bold mb-4">🎯 Gerar Ciclo de 40 Semanas</h2>
                <p class="mb-4">Distribui 419 temas do ENARE em 40 semanas de forma inteligente!</p>
                <button onclick="gerarCiclo()" class="bg-white text-indigo-600 hover:bg-gray-100 px-6 py-3 rounded-lg font-semibold">
                    <i class="fas fa-play mr-2"></i>Gerar Ciclo Agora
                </button>
            </div>

            <!-- Temas da Semana Atual -->
            <div class="bg-white rounded-lg shadow-lg p-6">
                <h2 class="text-2xl font-bold text-gray-800 mb-4">
                    <i class="fas fa-calendar-week text-indigo-600 mr-2"></i>Temas da Semana Atual
                </h2>
                <div id="temas-semana" class="space-y-3"></div>
            </div>
        </div>

        <!-- Tab: Ciclo 40 Semanas -->
        <div id="tab-ciclo" class="tab-content hidden">
            <div class="bg-white rounded-lg shadow-lg p-6">
                <h2 class="text-2xl font-bold text-gray-800 mb-4">
                    <i class="fas fa-calendar-alt text-indigo-600 mr-2"></i>Mapa das 40 Semanas
                </h2>
                <div id="mapa-semanas" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4"></div>
            </div>
        </div>

        <!-- Tab: Revisões -->
        <div id="tab-revisoes" class="tab-content hidden">
            <div class="bg-white rounded-lg shadow-lg p-6">
                <h2 class="text-2xl font-bold text-gray-800 mb-4">
                    <i class="fas fa-sync-alt text-orange-600 mr-2"></i>Revisões Pendentes
                </h2>
                <div id="lista-revisoes" class="space-y-3"></div>
            </div>
        </div>

        <!-- Tab: Métricas -->
        <div id="tab-metricas" class="tab-content hidden">
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div class="bg-white rounded-lg shadow-lg p-6">
                    <h3 class="text-xl font-bold text-gray-800 mb-4">📊 Acurácia por Área</h3>
                    <canvas id="chartAcuracia"></canvas>
                </div>
                <div class="bg-white rounded-lg shadow-lg p-6">
                    <h3 class="text-xl font-bold text-gray-800 mb-4">⚠️ Temas Mais Errados (&lt;70%)</h3>
                    <div id="temas-errados" class="space-y-2"></div>
                </div>
            </div>
        </div>
    </div>

    <script>
    let chartAcuracia = null

    async function logout() {
        await fetch('/api/auth/logout', { method: 'POST' })
        window.location.href = '/login'
    }

    function showTab(tab) {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.remove('active', 'bg-indigo-600', 'text-white')
            btn.classList.add('bg-white', 'text-gray-700')
        })
        document.querySelectorAll('.tab-content').forEach(content => content.classList.add('hidden'))

        const btn = document.querySelector(\`button[onclick="showTab('\${tab}')"]\`)
        btn.classList.add('active', 'bg-indigo-600', 'text-white')
        btn.classList.remove('bg-white', 'text-gray-700')

        document.getElementById(\`tab-\${tab}\`).classList.remove('hidden')

        if (tab === 'ciclo') loadSemanas()
        if (tab === 'revisoes') loadRevisoes()
        if (tab === 'metricas') loadMetricas()
    }

    async function gerarCiclo() {
        if (!confirm('Gerar seu ciclo personalizado de 40 semanas com 419 temas?')) return

        try {
            const res = await fetch('/api/ciclo/gerar', { method: 'POST' })
            const data = await res.json()

            if (data.success) {
                alert(\`Ciclo gerado! \${data.semanas} semanas criadas com \${data.temas_distribuidos} temas.\`)
                document.getElementById('gerador-ciclo').remove()
                loadDashboard()
            } else {
                alert('Erro: ' + data.error)
            }
        } catch (error) {
            alert('Erro ao gerar ciclo')
        }
    }

    async function loadDashboard() {
        try {
            const metricas = await fetch('/api/metricas').then(r => r.json())
            const semana = await fetch('/api/semana/atual').then(r => r.json())

            document.getElementById('total-estudos').textContent = metricas.total_estudos
            document.getElementById('total-questoes').textContent = metricas.total_questoes
            document.getElementById('acuracia-media').textContent = metricas.acuracia_media ? metricas.acuracia_media.toFixed(1) + '%' : '0%'
            document.getElementById('revisoes-pendentes').textContent = metricas.revisoes_pendentes

            const temasDiv = document.getElementById('temas-semana')
            if (semana.temas && semana.temas.length > 0) {
                document.getElementById('gerador-ciclo')?.remove()
                temasDiv.innerHTML = semana.temas.map(t => \`
                    <div class="border-l-4 border-indigo-600 rounded-lg p-4 bg-gray-50 hover:bg-gray-100 transition">
                        <div class="flex items-start justify-between">
                            <div class="flex-1">
                                <h3 class="font-bold text-gray-800">\${t.tema}</h3>
                                <p class="text-sm text-gray-600 mt-1">\${t.area} · <span class="font-semibold">\${t.prevalencia}</span></p>
                                <p class="text-xs text-gray-500 mt-2">\${t.subtopicos || ''}</p>
                            </div>
                            <button onclick="registrarEstudo(\${t.id})" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm">
                                <i class="fas fa-check mr-1"></i>Estudar
                            </button>
                        </div>
                    </div>
                \`).join('')
            } else if (semana.error) {
                temasDiv.innerHTML = '<p class="text-gray-600">Gere seu ciclo primeiro!</p>'
            }
        } catch (error) {
            console.error('Erro ao carregar dashboard:', error)
        }
    }

    async function loadSemanas() {
        try {
            const res = await fetch('/api/semanas')
            const data = await res.json()

            const mapaDiv = document.getElementById('mapa-semanas')
            if (data.semanas && data.semanas.length > 0) {
                mapaDiv.innerHTML = data.semanas.map(s => \`
                    <div class="border rounded-lg p-4 hover:shadow-lg transition">
                        <p class="font-bold text-indigo-600">Semana \${s.numero_semana}</p>
                        <p class="text-sm text-gray-600">\${s.total_temas || 0} temas</p>
                    </div>
                \`).join('')
            } else {
                mapaDiv.innerHTML = '<p class="text-gray-600 col-span-4">Nenhuma semana gerada. Clique em "Gerar Ciclo Agora".</p>'
            }
        } catch (error) {
            console.error('Erro ao carregar semanas:', error)
        }
    }

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

    async function loadMetricas() {
        try {
            const res = await fetch('/api/metricas')
            const data = await res.json()

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

    async function registrarEstudo(temaId) {
        const questoes = prompt('Quantas questões você fez?', '15')
        if (!questoes) return

        const acertos = prompt('Quantas você acertou?', '12')
        if (!acertos) return

        try {
            const res = await fetch('/api/estudo/registrar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tema_id: temaId,
                    metodo: 'questoes',
                    questoes_feitas: parseInt(questoes),
                    questoes_acertos: parseInt(acertos),
                    tempo_minutos: 60
                })
            })

            const data = await res.json()

            if (data.success) {
                alert(\`Estudo registrado! Acurácia: \${data.acuracia.toFixed(1)}%. \${data.revisoes_agendadas} revisões agendadas.\`)
                loadDashboard()
            } else {
                alert('Erro: ' + data.error)
            }
        } catch (error) {
            alert('Erro ao registrar estudo')
        }
    }

    async function concluirRevisao(id) {
        const acuracia = prompt('Como foi a revisão? (0-100)', '80')
        if (!acuracia) return

        try {
            const res = await fetch('/api/revisao/concluir', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, acuracia_revisao: parseFloat(acuracia) })
            })

            const data = await res.json()

            if (data.success) {
                alert('Revisão concluída!')
                loadRevisoes()
                loadDashboard()
            } else {
                alert('Erro: ' + data.error)
            }
        } catch (error) {
            alert('Erro ao concluir revisão')
        }
    }

    const style = document.createElement('style')
    style.textContent = \`
        .tab-btn.active {
            background-color: #4f46e5 !important;
            color: white !important;
        }
        .tab-btn:hover {
            background-color: #e0e7ff;
        }
        .tab-btn.active:hover {
            background-color: #4338ca !important;
        }
    \`
    document.head.appendChild(style)

    loadDashboard()
    </script>
</body>
</html>`

  return c.html(html)
})

export default app
