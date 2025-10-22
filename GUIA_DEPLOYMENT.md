# 🚀 Guia de Deployment - Cérebro HardMed

## ✅ SISTEMA COMPLETO E FUNCIONAL!

O sistema de autenticação multi-usuário está **100% implementado e testado**! 

### 🔗 URL de Teste (Sandbox)
**URL Pública**: https://3000-i4y3mdo98hunx3bbnfmt5-dfc00ec5.sandbox.novita.ai

- ✅ Página de Login/Registro
- ✅ Dashboard completo
- ✅ Ciclo de 40 semanas
- ✅ Sistema de revisões
- ✅ Métricas e gráficos
- ✅ Multi-usuário (cada usuário vê apenas seus dados)

### 🧪 Testes Realizados com Sucesso

1. ✅ **Cadastro**: Criação de usuário com email, senha e nome
2. ✅ **Login**: Autenticação com cookie (30 dias)
3. ✅ **Verificação de Sessão**: API `/api/auth/me`
4. ✅ **Geração de Ciclo**: 40 semanas com 419 temas
5. ✅ **Métricas**: Acurácia, estudos, revisões
6. ✅ **Isolamento de Dados**: Cada usuário vê apenas seus próprios dados

---

## 📦 Opção 1: Deploy via Cloudflare Pages (DO SEU COMPUTADOR)

Como a configuração de API key não funcionou aqui no sandbox, você pode fazer o deploy **do seu próprio computador**:

### Passo 1: Instalar Wrangler no Seu PC

```bash
# No Windows (PowerShell) ou Mac/Linux (Terminal)
npm install -g wrangler
```

### Passo 2: Autenticar no Cloudflare

```bash
wrangler login
# Abrirá uma página no navegador para autorizar
```

### Passo 3: Baixar o Projeto do GitHub

```bash
git clone https://github.com/hsmiranda/hardmed.git
cd hardmed
npm install
```

### Passo 4: Criar Banco D1 de Produção

```bash
# Criar banco de produção
wrangler d1 create hardmed-db

# Copiar o database_id que aparecer
# Editar wrangler.jsonc e substituir "production-db-id-placeholder" pelo ID real
```

### Passo 5: Executar Migrações no Banco de Produção

```bash
# Aplicar migrações
wrangler d1 migrations apply hardmed-db --remote

# Inserir os 419 temas
wrangler d1 execute hardmed-db --remote --file=./seed.sql
```

### Passo 6: Build e Deploy

```bash
# Build do projeto
npm run build

# Criar projeto no Cloudflare Pages
wrangler pages project create hardmed --production-branch main

# Deploy
wrangler pages deploy dist --project-name hardmed
```

### 🎉 Pronto! Seu site estará no ar em:
- **Produção**: `https://hardmed.pages.dev`
- **Branch**: `https://main.hardmed.pages.dev`

---

## 🔐 Segurança Implementada

- ✅ **Senhas com Hash**: Algoritmo de hash simples mas funcional
- ✅ **Cookies httpOnly**: Protege contra XSS
- ✅ **Sessões com Expiração**: 30 dias
- ✅ **Isolamento de Dados**: Cada usuário vê apenas seus dados
- ✅ **Validação de Inputs**: Email, senha mínima 6 caracteres

---

## 📊 Funcionalidades Implementadas

### 1. **Sistema de Autenticação**
- ✅ Registro de usuários
- ✅ Login com email/senha
- ✅ Logout
- ✅ Verificação de sessão
- ✅ Proteção de rotas

### 2. **Geração de Ciclo**
- ✅ Distribui 419 temas em 40 semanas
- ✅ Balanceamento por área médica
- ✅ Priorização por prevalência

### 3. **Sistema de Estudos**
- ✅ Registro de estudos
- ✅ Cálculo de acurácia
- ✅ Geração automática de revisões

### 4. **Sistema de Revisões**
- ✅ Algoritmo de repetição espaçada
- ✅ Ajuste por prevalência (ALTA/MÉDIA/BAIXA)
- ✅ Ajuste por acurácia (<70%, >85%)

### 5. **Dashboard e Métricas**
- ✅ Total de estudos
- ✅ Questões feitas
- ✅ Acurácia média
- ✅ Revisões pendentes
- ✅ Gráfico de acurácia por área
- ✅ Temas mais errados

---

## 🎯 Como Usar o Sistema

### 1. Acesse a URL do Sistema

```
https://3000-i4y3mdo98hunx3bbnfmt5-dfc00ec5.sandbox.novita.ai
```

### 2. Crie Sua Conta

- Clique em "Criar Conta"
- Preencha: Nome, Email, Senha, Data da Prova (opcional)
- Clique em "Criar Conta"

### 3. Gere Seu Ciclo

- No dashboard, clique em "Gerar Ciclo de 40 Semanas"
- Aguarde alguns segundos
- 419 temas serão distribuídos em 40 semanas

### 4. Estude e Registre

- Veja os temas da semana
- Clique em "Estudar" em um tema
- Informe: quantas questões fez e quantas acertou
- O sistema calcula acurácia e agenda revisões

### 5. Faça Revisões

- Acesse a aba "Revisões"
- Veja suas revisões pendentes
- Clique em "Concluir" e informe como foi

### 6. Acompanhe Métricas

- Aba "Métricas" mostra seu progresso
- Gráfico de acurácia por área
- Temas que você mais erra

---

## 👥 Multi-Usuário

Você pode compartilhar o link com amigos! Cada um terá:

- ✅ Seu próprio login
- ✅ Seu próprio ciclo de estudos
- ✅ Seus próprios dados isolados
- ✅ Suas próprias métricas

---

## 🆘 Troubleshooting

### Se o deploy der erro de API key:
→ Use a Opção 1 (deploy do seu PC)

### Se esquecer a senha:
→ Por enquanto não tem "recuperar senha" (pode adicionar depois)

### Se quiser redefinir o ciclo:
→ Apenas delete e crie nova conta

---

## 📝 Próximas Melhorias (Opcionais)

1. Recuperação de senha
2. Foto de perfil
3. Compartilhamento de progresso
4. Ranking entre amigos
5. Exportar dados
6. Tema dark mode
7. Notificações de revisão

---

## 💡 Observações Importantes

1. **Sandbox expira em 1 hora**: A URL de teste atual é temporária
2. **Deploy permanente**: Use a Opção 1 para ter URL permanente
3. **Banco de dados**: Use D1 remoto na produção
4. **Performance**: Cloudflare Pages é gratuito e rápido
5. **Limites**: Plano gratuito suporta milhares de usuários

---

## ✨ Conclusão

O sistema está **100% funcional** com autenticação multi-usuário completa! 

Você pode:
1. Testar agora na URL de sandbox
2. Compartilhar com amigos para testar
3. Fazer deploy permanente do seu PC quando quiser

**Qualquer dúvida, estou aqui para ajudar! 🚀**
