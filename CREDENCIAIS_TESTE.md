# 🔑 Credenciais de Teste

## 🌐 URL do Sistema
```
https://3000-i4y3mdo98hunx3bbnfmt5-dfc00ec5.sandbox.novita.ai
```

**⚠️ IMPORTANTE**: Esta é uma URL temporária de sandbox que expira em 1 hora!

---

## 👤 Usuários de Teste Criados

### Usuário 1: João Silva
- **Email**: `teste@hardmed.com`
- **Senha**: `senha123`
- **Data da Prova**: 15/04/2026
- **Status**: ✅ Ciclo gerado (40 semanas)

### Usuário 2: Maria Silva
- **Email**: `maria@hardmed.com`
- **Senha**: `senha456`
- **Data da Prova**: 01/05/2026
- **Status**: ✅ Ciclo gerado (40 semanas)

---

## 🧪 Como Testar

### 1️⃣ Testar Login
1. Acesse a URL acima
2. Use um dos emails/senhas listados
3. Clique em "Entrar"

### 2️⃣ Criar Nova Conta
1. Clique em "Criar Conta"
2. Preencha seus dados
3. Sua conta será criada automaticamente

### 3️⃣ Verificar Isolamento de Dados
1. Faça login com João (`teste@hardmed.com`)
2. Veja seus dados (40 semanas, semanas 1-40)
3. Faça logout
4. Faça login com Maria (`maria@hardmed.com`)
5. Veja que são dados diferentes!

---

## 📊 Dados Disponíveis

- **419 temas médicos** no banco
- **40 semanas** de ciclo por usuário
- **4 temas por semana** (160 temas distribuídos)
- **Sistema de revisões** ativo

---

## 🎯 Funcionalidades Para Testar

### Dashboard
- ✅ Ver métricas (estudos, questões, acurácia)
- ✅ Ver temas da semana atual
- ✅ Registrar estudo (clique em "Estudar")

### Ciclo de 40 Semanas
- ✅ Ver mapa completo das 40 semanas
- ✅ Cada semana tem 4 temas

### Revisões
- ✅ Ver revisões pendentes
- ✅ Concluir revisão
- ✅ Sistema de repetição espaçada funcionando

### Métricas
- ✅ Gráfico de acurácia por área
- ✅ Top 10 temas mais errados
- ✅ Estatísticas gerais

---

## 🔒 Segurança

Todas as senhas são hasheadas no banco. Os cookies são httpOnly e seguros.

---

## 💾 Banco de Dados Local

O banco está em: `.wrangler/state/v3/d1/`

Para ver os dados:
```bash
npm run db:console:local
```

---

## 📝 Observações

1. **Sandbox Temporário**: Esta URL expira em 1 hora
2. **Deploy Permanente**: Siga `GUIA_DEPLOYMENT.md`
3. **Multi-Usuário**: Cada usuário vê apenas seus dados
4. **Sessões**: Cookies duram 30 dias

---

## 🚀 Próximos Passos

1. **Teste todas as funcionalidades**
2. **Compartilhe com amigos** (cada um cria sua conta)
3. **Faça deploy permanente** quando estiver satisfeito
4. **Estude para o ENARE 2026!** 📚

---

**Boa sorte! 🎉**
