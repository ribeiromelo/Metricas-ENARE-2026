// ====================================================
// SISTEMA DE AUTENTICAÇÃO
// ====================================================

import { Context } from 'hono'

// Função simples de hash (para produção, use bcrypt)
export function hashPassword(password: string): string {
  // Simulação de hash (em produção, usar biblioteca adequada)
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
    SELECT s.*, u.id as usuario_id, u.email, u.nome, u.data_prova
    FROM sessoes s
    INNER JOIN usuarios u ON s.usuario_id = u.id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).bind(token).first()

  return sessao
}

export async function requireAuth(c: Context) {
  const token = c.req.header('Authorization')?.replace('Bearer ', '') || 
                c.req.cookie('auth_token')

  if (!token) {
    return c.json({ error: 'Não autenticado' }, 401)
  }

  const sessao = await getUsuarioFromToken(c.env.DB, token)
  
  if (!sessao) {
    return c.json({ error: 'Sessão inválida ou expirada' }, 401)
  }

  return sessao
}
