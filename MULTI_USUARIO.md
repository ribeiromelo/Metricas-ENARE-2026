# 👥 Sistema Multi-Usuário - HardMed

## 📋 Status Atual

### ✅ **O QUE JÁ FOI IMPLEMENTADO**

1. **Schema de Banco de Dados** ✅
   - Tabela `usuarios` (id, email, senha_hash, nome, data_prova)
   - Tabela `sessoes` (para autenticação via token)
   - Tabela `metas_estudo` (metas flexíveis: 4h/3h/2h)
   - Colunas `usuario_id` adicionadas em:
     - `configuracoes`
     - `semanas`
     - `estudos`

2. **Migrations Aplicadas** ✅
   - `0001_initial_schema.sql` (schema base)
   - `0002_add_users.sql` (multi-usuário)

3. **Sistema de Metas Flexíveis** ✅
   - Meta Ideal: 4h/dia, 4 temas
   - Meta Realista: 3h/dia, 3 temas
   - Meta Sobrevivência: 2h/dia, 2 temas

4. **Página de Login/Cadastro** ✅
   - Disponível em `/public/login.html`
   - Interface completa com tabs
   - Validação de formulários

---

## 🚧 **O QUE FALTA IMPLEMENTAR**

### **Backend - APIs de Autenticação**

Você precisará adicionar no `src/index.tsx`:

```typescript
// ====================================================
// API: CADASTRO
// ====================================================
app.post('/api/auth/cadastro', async (c) => {
  const { DB } = c.env
  
  try {
    const { email, senha, nome, data_prova } = await c.req.json()

    // Verificar se email já existe
    const existente = await DB.prepare('SELECT id FROM usuarios WHERE email = ?').bind(email).first()
    if (existente) {
      return c.json({ error: 'Email já cadastrado' }, 400)
    }

    // Hash simplificado (em produção, use bcrypt)
    const senhaHash = hashSenha(senha)

    // Criar usuário
    const result = await DB.prepare(`
      INSERT INTO usuarios (email, senha_hash, nome, data_prova)
      VALUES (?, ?, ?, ?)
    `).bind(email, senhaHash, nome, data_prova || null).run()

    const usuarioId = result.meta.last_row_id

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

    // Criar token de sessão
    const token = generateToken()
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

    await DB.prepare(`
      INSERT INTO sessoes (usuario_id, token, expires_at)
      VALUES (?, ?, ?)
    `).bind(usuarioId, token, expiresAt).run()

    return c.json({
      success: true,
      token,
      usuario: { id: usuarioId, email, nome }
    })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// ====================================================
// API: LOGIN
// ====================================================
app.post('/api/auth/login', async (c) => {
  const { DB } = c.env
  
  try {
    const { email, senha } = await c.req.json()
    const senhaHash = hashSenha(senha)

    const usuario = await DB.prepare(`
      SELECT id, email, nome, data_prova
      FROM usuarios
      WHERE email = ? AND senha_hash = ?
    `).bind(email, senhaHash).first()

    if (!usuario) {
      return c.json({ error: 'Email ou senha incorretos' }, 401)
    }

    // Criar token
    const token = generateToken()
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

    await DB.prepare(`
      INSERT INTO sessoes (usuario_id, token, expires_at)
      VALUES (?, ?, ?)
    `).bind(usuario.id, token, expiresAt).run()

    return c.json({
      success: true,
      token,
      usuario
    })

  } catch (error: any) {
    return c.json({ error: error.message }, 500)
  }
})

// ====================================================
// FUNÇÕES AUXILIARES
// ====================================================
function hashSenha(senha: string): string {
  // Hash simplificado (em produção, use bcrypt)
  let hash = 0
  for (let i = 0; i < senha.length; i++) {
    const char = senha.charCodeAt(i)
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
    SELECT s.*, u.id as usuario_id, u.email, u.nome
    FROM sessoes s
    INNER JOIN usuarios u ON s.usuario_id = u.id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).bind(token).first()

  return sessao
}
```

---

### **Modificar APIs Existentes**

Todas as APIs precisam:

1. **Verificar autenticação**:
```typescript
app.post('/api/ciclo/gerar', async (c) => {
  // Pegar token do header ou cookie
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  
  if (!token) {
    return c.json({ error: 'Não autenticado' }, 401)
  }

  const sessao = await getUsuarioFromToken(c.env.DB, token)
  
  if (!sessao) {
    return c.json({ error: 'Sessão inválida' }, 401)
  }

  const usuarioId = sessao.usuario_id
  
  // Resto do código usando usuarioId...
})
```

2. **Filtrar por usuario_id**:
```typescript
// Ao invés de:
SELECT * FROM semanas WHERE numero_semana = ?

// Usar:
SELECT * FROM semanas WHERE numero_semana = ? AND usuario_id = ?
```

---

## 🔧 **Como Implementar Autenticação Completa**

### **Passo 1: Adicionar Helper de Auth no Backend**

Crie arquivo `src/auth.ts`:

```typescript
import { Context } from 'hono'

export function hashPassword(password: string): string {
  let hash = 0
  for (let i = 0; i < password.length; i++) {
    const char = password.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(36)
}

export function generateToken(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36)
}

export async function getUsuarioFromToken(DB: D1Database, token: string) {
  if (!token) return null

  const sessao = await DB.prepare(`
    SELECT s.*, u.id as usuario_id, u.email, u.nome
    FROM sessoes s
    INNER JOIN usuarios u ON s.usuario_id = u.id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).bind(token).first()

  return sessao
}

export async function requireAuth(c: Context) {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')

  if (!token) {
    return c.json({ error: 'Não autenticado' }, 401)
  }

  const sessao = await getUsuarioFromToken(c.env.DB, token)
  
  if (!sessao) {
    return c.json({ error: 'Sessão inválida' }, 401)
  }

  return sessao
}
```

### **Passo 2: Modificar Frontend para Enviar Token**

Em todas as requisições fetch, adicionar:

```javascript
fetch('/api/ciclo/gerar', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
  }
})
```

### **Passo 3: Redirecionar Página Principal**

Na rota `/` do backend:

```typescript
app.get('/', async (c) => {
  const token = c.req.cookie('auth_token')
  
  if (!token) {
    return c.redirect('/login.html')
  }

  const sessao = await getUsuarioFromToken(c.env.DB, token)
  
  if (!sessao) {
    return c.redirect('/login.html')
  }

  // Renderizar página principal...
})
```

---

## 📊 **Exemplo Completo de Uso**

### **1. Cadastro de Novo Usuário**

```bash
curl -X POST http://localhost:3000/api/auth/cadastro \
  -H "Content-Type: application/json" \
  -d '{
    "email": "joao@med.com",
    "senha": "senha123",
    "nome": "João Silva",
    "data_prova": "2026-06-15"
  }'

# Resposta:
{
  "success": true,
  "token": "abc123xyz789",
  "usuario": {
    "id": 1,
    "email": "joao@med.com",
    "nome": "João Silva"
  }
}
```

### **2. Login**

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type": application/json" \
  -d '{
    "email": "joao@med.com",
    "senha": "senha123"
  }'
```

### **3. Gerar Ciclo (Autenticado)**

```bash
curl -X POST http://localhost:3000/api/ciclo/gerar \
  -H "Authorization: Bearer abc123xyz789"
```

---

## 🎯 **Sistema de Metas Flexíveis**

### **Estrutura no Banco**

```sql
CREATE TABLE metas_estudo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL UNIQUE,
  
  -- Meta Ideal (melhor cenário)
  meta_ideal_horas INTEGER DEFAULT 4,
  meta_ideal_temas INTEGER DEFAULT 4,
  
  -- Meta Realista (cenário provável)
  meta_realista_horas INTEGER DEFAULT 3,
  meta_realista_temas INTEGER DEFAULT 3,
  
  -- Meta Sobrevivência (mínimo aceitável)
  meta_sobrevivencia_horas INTEGER DEFAULT 2,
  meta_sobrevivencia_temas INTEGER DEFAULT 2,
  
  -- Meta atual ativa
  meta_atual TEXT DEFAULT 'ideal', -- 'ideal', 'realista', 'sobrevivencia'
  
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
);
```

### **API para Atualizar Metas**

```typescript
app.post('/api/metas', async (c) => {
  const sessao = await requireAuth(c)
  if (sessao.error) return sessao

  const {
    meta_ideal_horas,
    meta_ideal_temas,
    meta_realista_horas,
    meta_realista_temas,
    meta_sobrevivencia_horas,
    meta_sobrevivencia_temas,
    meta_atual
  } = await c.req.json()

  await c.env.DB.prepare(`
    UPDATE metas_estudo 
    SET meta_ideal_horas = ?, meta_ideal_temas = ?,
        meta_realista_horas = ?, meta_realista_temas = ?,
        meta_sobrevivencia_horas = ?, meta_sobrevivencia_temas = ?,
        meta_atual = ?
    WHERE usuario_id = ?
  `).bind(
    meta_ideal_horas, meta_ideal_temas,
    meta_realista_horas, meta_realista_temas,
    meta_sobrevivencia_horas, meta_sobrevivencia_temas,
    meta_atual, sessao.usuario_id
  ).run()

  return c.json({ success: true })
})
```

### **Usar Metas no Gerador de Ciclo**

```typescript
// Buscar meta atual do usuário
const metas = await DB.prepare('SELECT * FROM metas_estudo WHERE usuario_id = ?').bind(usuarioId).first()

let temasPorSemana = 4 // default
if (metas.meta_atual === 'realista') {
  temasPorSemana = metas.meta_realista_temas
} else if (metas.meta_atual === 'sobrevivencia') {
  temasPorSemana = metas.meta_sobrevivencia_temas
}

// Usar temasPorSemana no algoritmo de distribuição...
```

---

## 🚀 **Próximos Passos**

### **Prioridade Alta**
1. [ ] Implementar APIs de autenticação (`/api/auth/cadastro`, `/api/auth/login`)
2. [ ] Adicionar verificação de token em todas as APIs existentes
3. [ ] Modificar queries SQL para filtrar por `usuario_id`

### **Prioridade Média**
4. [ ] Implementar sistema de metas flexíveis na interface
5. [ ] Criar página de configurações de usuário
6. [ ] Adicionar botão de logout

### **Prioridade Baixa**
7. [ ] Melhorar hash de senha (usar bcrypt/argon2)
8. [ ] Adicionar refresh tokens
9. [ ] Implementar "esqueci minha senha"

---

## 📖 **Referências**

- **Hash de Senha**: Para produção, use `bcrypt` ou `argon2`
- **JWT**: Para tokens mais seguros, use `jsonwebtoken`
- **Cookies**: Use `httpOnly` e `secure` em produção

---

## ⚠️ **Notas Importantes**

1. **Segurança**: O hash de senha atual é simplificado. Em produção, use bcrypt.
2. **Tokens**: Tokens são armazenados em `localStorage` no frontend.
3. **Expiração**: Sessões expiram em 30 dias.
4. **Isolamento**: Cada usuário tem seus próprios semanas, estudos e revisões.

---

## 🎓 **Filosofia das Metas**

### **🎯 Meta Ideal (4h/dia)**
- Cenário perfeito
- Sem plantões ou compromissos
- Alta disciplina
- **160 temas em 40 semanas**

### **💪 Meta Realista (3h/dia)**
- Considera rotina real
- Alguns plantões
- Vida equilibrada
- **120 temas em 40 semanas**

### **🆘 Meta Sobrevivência (2h/dia)**
- Rotina pesada
- Muitos plantões
- Mínimo viável
- **80 temas em 40 semanas**

O usuário pode alternar entre as metas conforme a rotina mudar!

---

**Status**: Schema pronto, falta implementar APIs ✅
