# 🧠 Cérebro de Estudos HardMed

Sistema inteligente de estudos para **ENARE/REVALIDA/ENAMED** com revisão espaçada adaptativa.

---

## 🎯 Visão Geral

O **Cérebro de Estudos HardMed** é uma plataforma web full-stack que combina:

1. **Planejamento Macro** - Ciclo de 40 semanas até a prova
2. **Execução Flexível** - Guia diário sem calendário fixo
3. **Revisão Inteligente** - Sistema adaptativo baseado em prevalência e desempenho

---

## ✨ Funcionalidades Principais

### 📅 **1. Gerador de Ciclo de 40 Semanas**
- Distribui automaticamente **419 temas** do ENARE em 40 semanas
- Balanceamento inteligente por área médica
- Priorização por prevalência na prova (ALTA/MÉDIA/BAIXA)
- 4 temas por semana (1h cada = 4h/dia)

### 📚 **2. Dashboard Diário**
- **Guia do Dia**: mostra os temas da semana atual
- **Revisões Pendentes**: lista temas agendados para revisão hoje
- **Quick Stats**: métricas rápidas (estudos, questões, acurácia)

### 🔄 **3. Sistema de Revisões Inteligentes**
Algoritmo de revisão espaçada que ajusta intervalos baseado em:
- **Prevalência do tema** (5 = ALTA, 3 = MÉDIA, 1 = BAIXA)
- **Dificuldade pessoal** (acurácia <70% = revisar mais cedo)
- **Tempo até a prova** (intensifica revisões no último terço)

Intervalos base: `1d → 3d → 7d → 15d → 30d → 60d`

**Exemplos:**
- Tema ALTA prevalência + 65% acurácia → intervalo reduzido 50%
- Tema MÉDIA prevalência + 90% acurácia → intervalo alongado 40%

### 📊 **4. Métricas e Análises**
- **Acurácia por área** (gráfico de barras)
- **Temas mais errados** (zona vermelha <70%)
- **Total de questões feitas**
- **Revisões pendentes**
- **Progresso das 40 semanas**

---

## 🗄️ Arquitetura do Banco de Dados

### **Tabelas Principais**

```sql
temas (419 registros)
├── id, area, subarea, tema, subtopicos
├── prevalencia, prevalencia_numero (1-5)
└── prioridade, origem, observacoes

semanas (40 registros)
├── numero_semana (1-40)
├── data_inicio, data_fim
└── concluida

semana_temas (160 registros = 40 semanas × 4 temas)
├── semana_id → semanas.id
├── tema_id → temas.id
├── ordem (1-4)
├── metodo (questoes/teoria)
└── meta_questoes, meta_tempo_minutos

estudos (registros de cada sessão)
├── tema_id, semana_tema_id
├── data_estudo, metodo
├── questoes_feitas, questoes_acertos
├── acuracia (%)
└── tempo_minutos

revisoes (sistema de revisão espaçada)
├── estudo_id, tema_id
├── numero_revisao (1, 2, 3...)
├── data_agendada, data_realizada
├── intervalo_dias, acuracia_revisao
└── concluida (0/1)
```

---

## 🛠️ Stack Tecnológica

- **Backend**: Hono (framework web ultrarrápido)
- **Database**: Cloudflare D1 (SQLite distribuído)
- **Frontend**: HTML + TailwindCSS + Chart.js
- **Deploy**: Cloudflare Pages (edge computing)
- **Dev Server**: Wrangler + PM2

---

## 📊 Distribuição de Temas

Total de **419 temas** do ENARE/REVALIDA/ENAMED:

| Área | Temas | % |
|------|-------|---|
| Clínica Médica | 228 | 54.4% |
| Pediatria | 41 | 9.8% |
| Cirurgia Geral | 36 | 8.6% |
| Obstetrícia | 34 | 8.1% |
| Ginecologia | 24 | 5.7% |
| Outras | 24 | 5.7% |
| Medicina Preventiva | 16 | 3.8% |
| Psiquiatria | 16 | 3.8% |

**Prevalência:**
- 🔴 ALTA: 109 temas (26%)
- 🟡 MÉDIA: 296 temas (71%)
- 🟢 BAIXA: 14 temas (3%)

---

## 🚀 Como Usar

### **1. Gerar Ciclo de 40 Semanas**
1. Acesse a aba **"Ciclo 40 Semanas"**
2. Clique em **"Gerar Ciclo Agora"**
3. Sistema distribui 160 temas em 40 semanas (4 por semana)

### **2. Estudar (Guia do Dia)**
1. Na aba **Dashboard**, veja os 4 temas da semana atual
2. Clique em **"Concluir"** após estudar um tema
3. Informe: questões feitas, acertos, tempo
4. Sistema calcula acurácia e agenda revisões automaticamente

### **3. Fazer Revisões**
1. Veja revisões pendentes no **Dashboard**
2. Clique em **"Marcar Revisada"**
3. Informe a nova acurácia
4. Sistema ajusta próximas revisões

### **4. Acompanhar Métricas**
1. Acesse a aba **"Métricas"**
2. Visualize:
   - Acurácia por área
   - Temas mais errados
   - Total de estudos/questões

---

## 🖥️ APIs Disponíveis

### **Ciclo**
- `POST /api/ciclo/gerar` - Gera ciclo de 40 semanas

### **Semanas**
- `GET /api/semanas` - Lista todas as 40 semanas
- `GET /api/semana/atual` - Retorna semana atual com temas

### **Estudos**
- `POST /api/estudo/registrar` - Registra estudo + cria revisões

### **Revisões**
- `GET /api/revisoes/pendentes` - Lista revisões do dia
- `POST /api/revisao/concluir/:id` - Marca revisão como concluída

### **Métricas**
- `GET /api/metricas` - Estatísticas gerais

### **Configurações**
- `GET /api/config` - Busca configurações
- `POST /api/config` - Atualiza configurações

---

## 🔧 Desenvolvimento Local

### **Pré-requisitos**
- Node.js 18+
- npm

### **Setup**
```bash
# 1. Instalar dependências
npm install

# 2. Criar banco D1 local
npm run db:migrate:local

# 3. Popular com 419 temas
npm run db:seed

# 4. Build
npm run build

# 5. Iniciar servidor (dev)
npm run dev:sandbox

# Ou com PM2
pm2 start ecosystem.config.cjs
```

### **Scripts Disponíveis**
```bash
npm run dev              # Vite dev server
npm run dev:sandbox      # Wrangler dev com D1 local
npm run build            # Build produção
npm run deploy           # Deploy para Cloudflare Pages
npm run db:migrate:local # Aplicar migrations (local)
npm run db:migrate:prod  # Aplicar migrations (produção)
npm run db:seed          # Popular banco com temas
npm run db:console:local # Console SQL local
npm run clean-port       # Limpar porta 3000
```

---

## 📡 URLs

### **Desenvolvimento**
- **Local**: http://localhost:3000
- **Sandbox**: https://3000-i4y3mdo98hunx3bbnfmt5-dfc00ec5.sandbox.novita.ai

### **Produção** (após deploy)
- **Cloudflare Pages**: https://hardmed.pages.dev
- **Branch**: https://main.hardmed.pages.dev

---

## 🧪 Testando APIs

```bash
# Gerar ciclo
curl -X POST http://localhost:3000/api/ciclo/gerar

# Ver semanas
curl http://localhost:3000/api/semanas

# Ver semana atual
curl http://localhost:3000/api/semana/atual

# Registrar estudo
curl -X POST http://localhost:3000/api/estudo/registrar \
  -H "Content-Type: application/json" \
  -d '{"tema_id": 1, "metodo": "questoes", "questoes_feitas": 20, "questoes_acertos": 16, "tempo_minutos": 60}'

# Ver revisões pendentes
curl http://localhost:3000/api/revisoes/pendentes

# Ver métricas
curl http://localhost:3000/api/metricas
```

---

## 📈 Roadmap de Melhorias

### **Fase 1 - MVP** ✅
- [x] Gerador de ciclo de 40 semanas
- [x] Dashboard diário
- [x] Sistema de revisões
- [x] Métricas básicas

### **Fase 2 - Melhorias** 🚧
- [ ] Autenticação multi-usuário
- [ ] Editar/reorganizar temas manualmente
- [ ] Exportar relatórios PDF
- [ ] Notificações de revisões
- [ ] Modo escuro

### **Fase 3 - Avançado** 📋
- [ ] Integração com bancos de questões
- [ ] Pomodoro timer integrado
- [ ] Análise preditiva de acurácia
- [ ] Comparação com outros estudantes
- [ ] Gamificação (badges, streaks)

---

## 🎨 Design

- **UI/UX**: Clean, profissional, focado em produtividade
- **Cores**: Indigo (principal), Orange (revisões), Green (sucesso), Red (zona de perigo)
- **Responsivo**: Mobile-first design
- **Ícones**: Font Awesome 6

---

## 📝 Notas Técnicas

### **Por que Cloudflare D1?**
- SQLite distribuído globalmente
- Latência <10ms em qualquer região
- Queries complexas (JOINs) funcionam perfeitamente
- Migrations nativas
- Desenvolvimento local com `--local` flag

### **Por que Hono?**
- Framework ultraleve (3KB)
- Compatível com Cloudflare Workers
- TypeScript nativo
- Performance excepcional

### **Algoritmo de Revisão**
```javascript
function calcularIntervalos(prevalencia, acuracia) {
  let intervalos = [1, 3, 7, 15, 30, 60] // base
  
  // Ajuste por prevalência
  if (prevalencia === 5) intervalos = intervalos.map(i => i * 0.7)
  if (prevalencia === 1) intervalos = intervalos.map(i => i * 1.3)
  
  // Ajuste por acurácia
  if (acuracia < 70) intervalos = intervalos.map(i => i * 0.6)
  if (acuracia > 85) intervalos = intervalos.map(i => i * 1.4)
  
  return intervalos
}
```

---

## 🤝 Contribuindo

Sugestões e melhorias são bem-vindas!

---

## 📄 Licença

Projeto educacional - uso livre para estudantes de medicina.

---

## 👤 Autor

Desenvolvido como ferramenta de estudos para **ENARE 2026**.

**Bons estudos! 🩺📚**
