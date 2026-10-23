# Pi-Father Spinner (`pi-father-spinner`)

Orquestrador persistente (**Pi-Father**) e bridge Telegram multi-instância para o agente de código **Pi** (`@earendil-works/pi-coding-agent`).

Permite que o seu agente Pi principal (conectado ao seu bot mestre do Telegram) gerencie um **Pool de Bots do Telegram** (previamente criados no `@BotFather`) e **"spinne"** novos agentes Pi independentes em sessões `tmux` dedicadas, cada um no seu diretório de projeto, rebatizando automaticamente o **nome de exibição (`setMyName`)** do bot do Telegram e pré-autorizando a sua conta.

---

## Arquitetura

1. **[`extensions/telegram.ts`](./extensions/telegram.ts) — Bridge Telegram Multi-Instância:**
   * Baseada na extensão oficial [`badlogic/pi-telegram`](https://github.com/badlogic/pi-telegram) (streaming nativo via `sendMessageDraft` + fallback `editMessageText`, envio/recebimento de imagens/arquivos com `telegram_attach`, `/status`, `/compact`, `/stop`).
   * **Isolamento por instância:** Suporta `PI_TELEGRAM_CONFIG=/caminho/config.json` (ou `--telegram-config`) e diretório temporário isolado por agente.
   * **Auto-Connect:** Suporta `PI_TELEGRAM_AUTOCONNECT=1` (ou `--telegram-autoconnect` / `"autoConnect": true`), iniciando o polling do Telegram automaticamente assim que a sessão `tmux` sobe.
   * **Mudança de Nome de Display (`setMyName`):** Inclui a tool `telegram_set_bot_profile`, o comando TUI `/telegram-name <novo nome>` e o comando direto no chat do Telegram `/name <novo nome>`.

2. **[`extensions/father-spinner.ts`](./extensions/father-spinner.ts) — Extensão Orquestradora do Pi-Father:**
   * Equipa o agente Pi-Father com ferramentas (`father_*`) e comandos (`/father-*`) para gerenciar o pool de bots e o ciclo de vida das sessões `tmux`.
   * **Guard Automático (`PI_CHILD_AGENT=1`):** Não carrega as ferramentas de orquestração dentro dos agentes filhos, mantendo os filhos enxutos.

3. **[`src/store.ts`](./src/store.ts) & [`src/orchestrator.ts`](./src/orchestrator.ts) — Estado Durável em SQLite + Auto-Recovery:**
   * Inspirado no modelo transacional do `@earendil-works/pi-durable`, utiliza o `node:sqlite` nativo em modo **WAL** (`~/.pi/agent/father-spinner/state.sqlite`) com transações atômicas (`BEGIN IMMEDIATE`) e log de auditoria (`audit_log`).
   * **Crash Recovery de Sessões `tmux`:** Sempre que o Pi-Father inicia (`session_start`) ou quando `father_reconcile_agents` (`/father-recover`) é chamado, ele verifica todos os agentes marcados como `running` no SQLite contra as sessões `tmux` vivas na VM e **recria automaticamente** qualquer sessão caída usando `pi -c` (`--continue`) reconectada ao mesmo bot do Telegram.

---

## Como Iniciar o Pi-Father (Nuvem 24/7 — AWS Lightsail via Terraform)

Toda a infraestrutura de nuvem (VM Ubuntu 24.04 LTS no AWS Lightsail, IP Estático, Chave SSH, Firewall, instalação de Node 24 + `tmux` + Pi CLI, configuração do serviço `systemd` 24/7, sincronização do pool de bots e deploy do código) é gerenciada 100% pelo **Terraform** na pasta [`infra/`](./infra/).

### 1. Configurar variáveis (`infra/terraform.tfvars`)
Copie o arquivo de exemplo e preencha o token do bot principal (`father_bot_token`), seu ID do Telegram (`allowed_telegram_user_id`) e os tokens do pool (`bot_pool`):

```bash
cp infra/terraform.tfvars.example infra/terraform.tfvars
```

### 2. Provisionar e Fazer Deploy (Comando Único)
```bash
make infra-init
make infra-apply
```

O `terraform apply` executa duas camadas integradas:
1. **`aws_lightsail_instance` + `cloud-init` ([`infra/templates/cloud-init.sh.tftpl`](./infra/templates/cloud-init.sh.tftpl)):** Cria a VM com IP fixo, abre apenas a porta 22 (SSH), instala `tmux`, `git`, `ripgrep`, `sqlite3`, **Node.js 24 LTS**, **`@earendil-works/pi-coding-agent`** e registra o serviço `systemd` **`pi-father.service`**.
2. **`terraform_data.app_deploy` ([`infra/main.tf`](./infra/main.tf)):** Empacota o código do projeto (`data.archive_file.app_bundle`), envia via SSH, roda a suíte de testes (`npm test`) dentro da VM, sincroniza as credenciais/tokens no SQLite ([`bin/sync-pool.ts`](./bin/sync-pool.ts)) e reinicia o `pi-father.service` — **sem nunca destruir a VM quando você alterar o código TypeScript!**

### 3. Comandos de Operação Remota (`Makefile`)
* `make infra-apply` — Provisiona a VM ou publica alterações de código/configuração sem recriar a máquina.
* `make attach-father` — Abre conexão SSH direto na tela `tmux` ao vivo do `pi-father` rodando na nuvem.
* `make status` — Mostra o status do serviço `systemd` e lista todas as sessões `tmux` (pai e filhos) ativas na VM.
* `make ssh` — Abre um terminal SSH na VM da AWS.

---

## Como Iniciar Localmente (Desenvolvimento)

### Opção A: Usando o script de inicialização (em `tmux`)
```bash
./bin/pi-father.sh
```
Isso cria (ou dá attach se já existir) a sessão `tmux` **`pi-father`** já com as duas extensões carregadas e auto-connect ativo.

### Opção B: Instalando como pacote local no Pi
```bash
pi install /home/dante/projects/pi-father-spinner
```
Ou rodando manualmente:
```bash
pi -e /home/dante/projects/pi-father-spinner
```

---

## Configuração Inicial

1. **Configurar o Bot do Pi-Father (apenas na 1ª vez):**
   Dentro do Pi-Father, execute:
   ```text
   /telegram-setup
   ```
   Cole o token do seu bot principal do `@BotFather` e envie `/start` para ele no Telegram para parear seu `allowedUserId`. *(Todos os bots filhos spinnados pelo Pi-Father herdarão automaticamente o seu `allowedUserId`!)*

2. **Adicionar Bots Filhos ao Pool:**
   Você pode cadastrar os tokens dos bots extras (criados no `@BotFather`) de 3 formas:
   * **Conversando em linguagem natural com o Pi-Father no Telegram:**
     > *"Adicione este bot no seu pool: `123456789:ABCdef...`"*
   * **Via comando no terminal do Pi-Father:**
     ```text
     /father-pool add 123456789:ABCdef...
     ```
   * **Importando um arquivo JSON (veja [`bots-pool.example.json`](./bots-pool.example.json)):**
     > *"Sincronize o pool de bots a partir do arquivo `/caminho/bots-pool.json`"*

---

## Ferramentas do LLM (Para pedir pelo Telegram ao Pi-Father)

| Tool | O que faz |
| :--- | :--- |
| `father_bot_pool` | Lista os bots do pool (`list`), adiciona novo token (`add`), remove (`remove`) ou importa de arquivo JSON (`sync_file`). |
| `father_spin_agent` | Aloca um bot livre do pool, muda seu **Display Name** no Telegram via `setMyName` (ex: `"Pi • meu-projeto"`), cria a sessão `tmux` (`pi-meu-projeto`) no diretório do projeto, envia boas-vindas e retorna o link `https://t.me/<bot_username>`. |
| `father_list_agents` | Lista todos os agentes spinnados, status ao vivo no `tmux`, diretório (`cwd`), `@bot_username` e display name atual. |
| `father_rename_bot` | Altera a qualquer momento o nome de exibição (`setMyName`) e/ou descrição curta (`setMyShortDescription`) de qualquer bot ou agente ativo. |
| `father_stop_agent` | Encerra a sessão `tmux` do agente filho, devolve o bot para o pool (`available`) e reseta o display name do bot no Telegram. |
| `father_inspect_agent` | Captura as últimas linhas do terminal `tmux` de um agente filho (`capture`) ou envia teclas/comandos para ele (`send_keys`). |
| `father_reconcile_agents` | Reconcilia o banco SQLite com o `tmux` e recupera automaticamente sessões caídas com `pi -c`. |
| `telegram_set_bot_profile` | (Disponível no pai e nos filhos) Permite que qualquer agente mude seu próprio nome de exibição no Telegram (`setMyName`) quando pedido na conversa com ele. |

---

## Comandos Slash (`/`)

### Na extensão `telegram.ts` (Pai e Filhos)
* `/telegram-setup` — Configura o token do bot da sessão atual.
* `/telegram-connect` / `/telegram-disconnect` — Inicia ou para o polling do Telegram.
* `/telegram-status` — Mostra o `@bot`, display name, arquivo de config e status.
* `/telegram-name <Novo Nome>` — Altera o nome de exibição do bot no Telegram (`setMyName`).
* *(Direto no chat do Telegram)*: `/status`, `/name <Novo Nome>`, `/compact`, `/stop`, `/help`.

### Na extensão `father-spinner.ts` (Apenas no Pi-Father)
* `/father-pool [add <token>]` — Lista os bots do pool ou adiciona um novo token.
* `/father-spin <nome-do-projeto> [Nome de Exibição]` — Spinna um novo agente Pi em `tmux` com um bot do pool.
* `/father-agents` — Lista os agentes ativos e seus bots.
* `/father-stop <nome-do-projeto>` — Para o agente, encerra o `tmux` e libera o bot no pool.
* `/father-recover` — Executa a recuperação durável de sessões `tmux` caídas.
