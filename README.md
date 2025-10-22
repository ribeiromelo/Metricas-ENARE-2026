# 🧠 Cérebro de Estudos HardMed

Sistema Inteligente de Revisões para ENARE 2026

## 🌐 URLs

- **Produção**: https://hardmed.pages.dev/
- **GitHub**: https://github.com/ribeiromelo/Metricas-ENARE-2026

## 📊 Funcionalidades Implementadas

### ✅ Sistema de Autenticação Multi-Usuário
- Login/Cadastro com cookies seguros (httpOnly, 30 dias)
- Isolamento de dados por usuário
- Landing page profissional

### ✅ Ciclo de Estudos (40 Semanas)
- **419 temas** importados e organizados
- Distribuição inteligente por:
  - Prevalência (ALTA, MÉDIA, BAIXA)
  - Áreas médicas balanceadas
  - 4 temas por semana
- **Performance otimizada** com batch inserts

### ✅ Sistema de Revisão Espaçada Adaptativo
- Intervalos ajustados por:
  - **Prevalência**: Temas ALTA revisam mais frequentemente
  - **Performance**: <70% reduz intervalos, >85% aumenta
- Intervalos cumulativos: 1d → 4d → 11d → 26d → 56d → 116d
- Bloqueio de revisões futuras
- Modal de método de revisão (Questões vs FlashCards)

### ✅ Meta de Questões ENARE 2026
- **Objetivo**: 15.000 questões até setembro/2026
- **Checkpoints trimestrais**: Março (3k), Junho (6k), Setembro (9k), Dezembro (12k), Final (15k)
- **Métricas calculadas**:
  - Ritmo atual (questões/dia desde início)
  - Ritmo necessário para alcançar meta
  - Projeção final baseada no ritmo atual
  - Status de cada checkpoint (atingido/falta)
- **Visualização**: Card gradiente com barra de progresso animada

### ✅ Métricas Avançadas (25+ indicadores)
- **Visão Geral**: Total estudos, questões, acurácia, revisões
- **Tempo**: Horas estudadas, média/dia, sequência de dias
- **Performance**: Taxa de sucesso, evolução temporal, distribuição por área
- **Análise**: Temas fracos, temas dominados, mais revisados
- **Progresso do Ciclo**: Semanas concluídas, temas estudados, % conclusão

### ✅ Interface Moderna
- **Header gradiente** (indigo → purple → pink) com animação shimmer
- **Tema claro/escuro** com toggle (padrão: light)
- **Design responsivo** com TailwindCSS
- **Glassmorphism** effects
- **Modais customizados** substituindo alerts/prompts do navegador

### ✅ Funcionalidades de Estudo
- Registro de estudo com acurácia
- Cálculo automático de revisões
- Marcação de temas como "Estudado"
- Atualização automática da interface (sem F5)
- Formato de datas brasileiro (DD/MM/YYYY)
- Timezone Brasil (America/Sao_Paulo)

## 🏗️ Arquitetura

### **Frontend**
- HTML inline com TailwindCSS (CDN)
- JavaScript vanilla
- Font Awesome icons
- Chart.js para gráficos

### **Backend**
- **Framework**: Hono 4.0
- **Runtime**: Cloudflare Workers
- **Banco**: Cloudflare D1 (SQLite)
- **Deploy**: Cloudflare Pages (auto-deploy via GitHub)

### **Estrutura do Banco**
- `usuarios` - Autenticação e perfis
- `temas` - 419 temas médicos
- `semanas` - Ciclo de 40 semanas
- `semana_temas` - Relação semana-tema
- `estudos` - Registro de estudos realizados
- `revisoes` - Sistema de revisão espaçada
- `configuracoes` - Configurações por usuário
- `sessoes` - Gerenciamento de sessões
- `metas_estudo` - Metas personalizáveis

## 🚀 Deploy

### **Requisitos**
- Conta Cloudflare
- Banco D1 criado: `hardmed-db`
- GitHub conectado ao Cloudflare Pages

### **Comandos Locais**
```bash
# Desenvolvimento
npm install
npm run build
npm run dev:d1  # Com D1 local

# Deploy
git push origin main  # Auto-deploy via Cloudflare Pages
```

### **Configuração D1**
Database ID: `1740c3f2-2b52-4c98-8fbc-ccafdbde0bdd`

Binding configurado em Cloudflare Pages:
- Variable: `DB`
- Database: `hardmed-db`

## 📈 Métricas do Sistema

- **Temas**: 419 importados
- **Semanas**: 40 no ciclo
- **Usuários**: Multi-usuário com isolamento
- **Performance**: Batch inserts (100x mais rápido)
- **Deploy**: ~30-60s via Cloudflare Pages

## 🎯 Próximos Passos Sugeridos

1. **Gamificação**: Badges, níveis, conquistas
2. **Estatísticas Avançadas**: Heatmaps, calendário de estudos
3. **Exportação**: PDF, CSV dos dados
4. **Notificações**: Email/push para revisões pendentes
5. **Compartilhamento**: Métricas públicas/privadas
6. **Integração**: Bancos de questões externos
7. **Mobile**: PWA ou app nativo

## 🛠️ Melhorias Técnicas Recentes

- ✅ Otimização de geração de ciclo com batch inserts
- ✅ Endpoint de importação de temas
- ✅ Header redesenhado com gradiente
- ✅ Correção de contadores de semanas concluídas
- ✅ Timezone brasileiro em todas as datas
- ✅ Meta de questões ENARE 2026 implementada

## 📝 Notas

**Mensagem Motivacional**: 
> "Essas metas servem para ter senso de progresso, não de culpa. A constância vence o volume isolado."

## 🔒 Segurança

- Cookies httpOnly e secure
- Senha com hash (implementado)
- Sessões com expiração
- Isolamento de dados por usuário
- API protegida com autenticação

## 📅 Status do Projeto

**Versão**: 1.0 (Produção)
**Última Atualização**: 22/10/2025
**Status**: ✅ Online e Funcionando

---

Desenvolvido com 💙 para preparação ENARE 2026
