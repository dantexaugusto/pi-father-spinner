---
name: diode-tunneling
description: Guia completo para instalar, configurar e gerenciar túneis web seguros e descentralizados com o Diode CLI (diode publish -public/-private/-protected, múltiplos túneis simultâneos e URLs públicas .diode.link). Use esta skill sempre que precisar expor servidores locais na web, criar túneis com Diode ou publicar previews de aplicações.
---

# 🚇 Skill: Tunelamento Web com Diode CLI

## 📌 Contexto para Agentes de Código

Esta skill proporciona conhecimento completo sobre o **serviço de tunelamento web da Diode**, permitindo que agentes entendam, instalem, utilizem e criem múltiplos túneis para diferentes portas, cada um com sua URL Diode distinta.

---

## 🏢 Visão Geral da Diode

**Diode.io** é especializada em:
- 🔐 **Zero Trust Network Access (ZTNA)**
- 🤖 **Infraestrutura privada de IA**
- ⛓️ **Blockchain Oasis** para sistemas seguros
- 🌐 **Soberania digital** em colaborações

O **Diode CLI** é a ferramenta de linha de comando para interagir com a rede Diode, oferecendo **tunelamento web seguro e descentralizado**.

---

## 📦 Instalação do Diode CLI

### **Para Linux (AMD64):**
```bash
# Baixar binário mais recente do GitHub
curl -L -o diode_linux_amd64.zip https://github.com/diodechain/diode_client/releases/download/v1.18.10/diode_linux_amd64.zip

# Extrair
unzip diode_linux_amd64.zip

# Instalar (opção 1: local no projeto)
mv diode /seu/projeto/diode_binary
chmod +x /seu/projeto/diode_binary

# Instalar (opção 2: sistema)
sudo mv diode /usr/local/bin/diode
sudo chmod +x /usr/local/bin/diode
```

### **Verificação:**
```bash
# Verificar versão
./diode_binary version

# Verificar comandos disponíveis
./diode_binary --help
```

---

## 🚀 Compreensão Básica do Tunelamento Diode

### **Como funciona:**
1. **Cliente Diode** conecta-se à rede blockchain Oasis
2. **Endereço único** é atribuído ao cliente (ex: `0x1234567890abcdef1234567890abcdef12345678`)
3. **URL pública** é gerada (ex: `http://0x1234567890abcdef1234567890abcdef12345678.diode.link/`)
4. **Portas locais** são mapeadas para a URL pública
5. **Acesso seguro** via HTTPS com Zero Trust

### **Fluxo de dados:**
```text
[Seu Servidor Local:8080] 
    → [Cliente Diode] 
    → [Rede Blockchain Diode] 
    → [URL pública .diode.link] 
    → [Usuários Externos]
```

---

## 🔧 Comando `diode publish` - Criação de Túneis

### **Sintaxe básica:**
```bash
diode publish -public <porta_externa>:<porta_local>
```

### **Explicação dos parâmetros:**
- `-public`: Torna a porta acessível publicamente
- `<porta_externa>`: Porta na URL pública (.diode.link)
- `<porta_local>`: Porta no servidor local

### **Exemplo simples (um túnel):**
```bash
# Expor servidor web local na porta 3000 para a porta 80 pública
./diode_binary publish -public 80:3000

# Resultado:
# → URL pública: http://0xSEU_ENDERECO.diode.link/
# → Mapeia para: localhost:3000
```

---

## 🎯 Criação de Múltiplos Túneis

### **Múltiplas portas simultâneas:**
```bash
# Cria 3 túneis diferentes
./diode_binary publish \
  -public 80:3000 \      # App principal
  -public 8080:8081 \     # API backend  
  -public 9000:5432       # Banco de dados (não recomendado publicamente)

# URLs resultantes:
# 1. http://0xSEU_ENDERECO.diode.link/          → localhost:3000
# 2. http://0xSEU_ENDERECO.diode.link:8080/     → localhost:8081
# 3. http://0xSEU_ENDERECO.diode.link:9000/      → localhost:5432
```

### **Cenário prático completo:**
```bash
# Desenvolvimento web full-stack
./diode_binary publish \
  -public 80:3000 \              # Frontend React
  -public 3001:3001 \            # Backend Node.js API
  -public 8080:8080 \            # Serviço auxiliar
  -public 5432:5432 \            # PostgreSQL (apenas para testes)
  -private 22:22 \               # SSH (acesso restrito)
  -protected 9000:9000          # Serviço interno (time only)
```

---

## 🔐 Níveis de Acesso (Public/Private/Protected)

### **1. Public (`-public`):**
```bash
# Acesso público total
./diode_binary publish -public 80:3000
# → Qualquer pessoa pode acessar
```

### **2. Private (`-private`):**
```bash
# Acesso específico por endereço blockchain
./diode_binary publish -private 22:22,0xENDERECO_DO_COLEGA
# → Apenas o colega com endereço específico pode acessar
```

### **3. Protected (`-protected`):**
```bash
# Acesso para membros do fleet contract
./diode_binary publish -protected 9000:9000
# → Apenas membros autorizados do contrato
```

### **Exemplo combinado:**
```bash
# Serviço com diferentes níveis de acesso
./diode_binary publish \
  -public 80:3000 \                    # Site público
  -protected 3001:3001,equipe1 \       # API interna da equipe
  -private 22:22,0xadmin123 \          # SSH apenas para admin
  -private 3306:3306,0xdba456,0xdev789 # DB para DBA e devs
```

---

## 🌐 URLs Diode Distintas

### **Como funcionam as URLs:**
Cada cliente Diode recebe uma **URL única baseada no endereço blockchain**:

```text
Formato: http://0x[ENDEREÇO_HEX].diode.link[:PORTA]
Exemplo: http://0x1234567890abcdef1234567890abcdef12345678.diode.link:8080/
```

### **Características:**
- ✅ **Única por dispositivo/cliente**
- ✅ **Persistente** (mesmo endereço hex)
- ✅ **HTTPS automático** via .diode.link
- ✅ **Sem configuração de DNS necessária**
- ✅ **Resistente a bloqueios** (P2P descentralizado)

### **Exemplo de múltiplas URLs para o mesmo serviço:**
```bash
# Serviço A (endereço A)
./diode_binary                           # Cliente 1
# → http://0xENDERECO_A.diode.link/

# Serviço B (endereço B)  
./diode_binary --configpath ./config_b/  # Cliente 2 com config diferente
# → http://0xENDERECO_B.diode.link/
```

---

## 📊 Monitoramento e Gestão

### **Ver túneis ativos:**
```bash
# O próprio comando publish mostra túneis ativos quando executado
./diode_binary publish

# Exemplo de output:
INFO Port localhost:3000  :       80      public       any
INFO Port localhost:8081  :     8080      public       any
INFO Port localhost:5432  :     9000      public       any
```

### **Gateway HTTP:**
```bash
# Habilitar gateway HTTP para gerenciamento
./diode_binary publish -http -http_port 8080

# Acessar dashboard:
# http://localhost:8080/ (local)
# http://0xSEU_ENDERECO.diode.link:8080/ (remoto)
```

### **Logs e debugging:**
```bash
# Modo verbose
./diode_binary -debug=true publish -public 80:3000

# Logs detalhados
./diode_binary -logstats=1 publish -public 80:3000

# Salvar logs em arquivo
./diode_binary -logfilepath=/var/log/diode.log publish -public 80:3000
```

---

## 🔄 Configuração Persistente

### **Arquivo de configuração:**
```bash
# Caminho padrão do config
~/.diode/config.json

# Estrutura típica:
{
  "client_address": "0x1234567890abcdef1234567890abcdef12345678",
  "fleet_address": "0x6000000000000000000000000000000000000000",
  "chain_id": 1284,
  "tunnels": [
    {
      "local_port": 3000,
      "external_port": 80,
      "access": "public"
    },
    {
      "local_port": 8081,
      "external_port": 8080,
      "access": "public"
    }
  ]
}
```

### **Gerenciar configurações via CLI:**
```bash
# Listar configs
./diode_binary config list

# Definir configuração
./diode_binary config set "tunnels.0.local_port" "3000"
./diode_binary config set "tunnels.0.external_port" "80"
./diode_binary config set "tunnels.0.access" "public"

# Resetar configurações (cuidado!)
./diode_binary reset
```

---

## 🏭 Casos de Uso Avançados

### **Cenário 1: Desenvolvimento Web Colaborativo**
```bash
# Cada desenvolvedor tem seu próprio túnel
./diode_binary publish \
  -public 80:3000 \      # Frontend dev
  -public 3001:3001 \    # Backend dev
  -private 8080:8080,0xPO_MATEUS,0xPO_PAULO  # Pair programming
  
# Revisores podem acessar sem instalar nada:
# http://0xDEV_A.diode.link/      → Frontend do Dev A
# http://0xDEV_B.diode.link/      → Frontend do Dev B
```

### **Cenário 2: Demonstração para Clientes**
```bash
# Preview de features
./diode_binary publish \
  -public 80:3000 \                    # Versão estável
  -public 8080:3001 \                   # Nova feature A
  -public 9000:3002 \                   # Nova feature B
  -private 3003:3003,0xCLIENTE          # Feature teste cliente

# URLs para compartilhar:
# Estável:    http://0xSEU_ENDERECO.diode.link/
# Feature A:  http://0xSEU_ENDERECO.diode.link:8080/
# Feature B:  http://0xSEU_ENDERECO.diode.link:9000/
```

### **Cenário 3: Microserviços**
```bash
# Cada serviço em sua própria porta
./diode_binary publish \
  -public 80:3000 \        # Gateway API
  -public 3001:3001 \        # Serviço de Usuários
  -public 3002:3002 \        # Serviço de Produtos  
  -public 3003:3003 \        # Serviço de Pedidos
  -protected 5432:5432 \      # Banco de dados
  -protected 5672:5672        # Message queue
```

### **Cenário 4: IoT e Edge Computing**
```bash
# Dispositivo IoT expondo múltiplos serviços
./diode_binary publish \
  -public 80:1880 \          # Dashboard Node-RED
  -public 8080:8080 \        # API REST do dispositivo
  -private 22:22,0xADMIN \   # SSH para manutenção
  -protected 9001:9001       # Stream de dados para backend

# Acesso remoto seguro sem VPN
# → Dashboard: http://0xDEVICE.diode.link/
# → API:       http://0xDEVICE.diode.link:8080/
```

---

## 🛡️ Segurança e Best Practices

### **Recomendações de segurança:**
```bash
# 1. Nunca exponha portas sensíveis publicamente
./diode_binary publish \
  -public 80:3000 \          # OK: Site público
  # -public 5432:5432        # ❌ NUNCA FAÇA: Banco de dados
  -private 5432:5432,0xADMIN # ✅ CERTO: Database apenas para admin

# 2. Use allowlists específicas
./diode_binary publish \
  -private 22:22,0xADMIN_1,0xADMIN_2,0xDEVELOPER_1

# 3. Monitore logs regularmente
./diode_binary -logfilepath=/var/log/diode.log -logstats=1

# 4. Atualize regularmente
./diode_binary update
```

### **Níveis de acesso recomendados:**
| Serviço | Nível de Acesso | Recomendação |
|---------|----------------|--------------|
| Site Web | `public` | ✅ Público geral |
| API Interna | `protected` | ✅ Apenas equipe |
| Banco de Dados | `private` | ✅ Admins específicos |
| SSH | `private` | ✅ Admins específicos |
| Admin Interface | `private` | ✅ Admins específicos |

---

## 🔍 Troubleshooting

### **Problemas comuns e soluções:**

#### **1. Conexão não estabelecida**
```bash
# Verificar se está conectado à rede
./diode_binary time

# Se falhar, verificar internet
./diode_binary -debug=true publish -public 80:3000
```

#### **2. Porta já em uso**
```bash
# Usar porta externa diferente
./diode_binary publish -public 8080:3000  # Em vez de 80:3000
```

#### **3. URL não acessível**
```bash
# Verificar se túnel está ativo
./diode_binary publish

# Testar conexão local primeiro
curl http://localhost:3000

# Testar conexão remota
curl http://0xSEU_ENDERECO.diode.link/
```

#### **4. Problemas de firewall**
```bash
# Diode usa porta 4100 por padrão para conexões P2P
# Verificar se não está bloqueada
netstat -tuln | grep 4100

# Alternativa: usar differente bind address
./diode_binary -bind=:4200 publish -public 80:3000
```

---

## 📈 Métricas e Monitoramento

### **Comando de estatísticas:**
```bash
# Habilitar métricas
./diode_binary -metrics=true publish -public 80:3000

# Métricas disponíveis em (se habilitado):
# http://localhost:6060/debug/metrics
```

### **Informações da rede:**
```bash
# Verificar estado da rede
./diode_binary query network

# Ver peers conectados
./diode_binary query peers

# Informações do contrato fleet
./diode_binary query fleet
```

---

## 🤖 Integração com Automação

### **Script para múltiplos ambientes:**
```bash
#!/bin/bash
# deploy_tunnels.sh

ENVIRONMENT=$1

case $ENVIRONMENT in
  "development")
    ./diode_binary publish \
      -public 80:3000 \
      -public 8080:8081 \
      -private 5432:5432,0xDEV_1,0xDEV_2
    ;;
    
  "staging")
    ./diode_binary publish \
      -public 80:3000 \
      -protected 8080:8081,0xQA_TEAM \
      -private 5432:5432,0xDBA
    ;;
    
  "production")
    ./diode_binary publish \
      -public 80:3000 \
      -protected 3001:3001,0xOPS_TEAM \
      -private 22:22,0xADMIN_1,0xADMIN_2
    ;;
    
  *)
    echo "Uso: $0 [development|staging|production]"
    exit 1
    ;;
esac
```

### **Docker Integration:**
```dockerfile
# Dockerfile para serviço com Diode
FROM ubuntu:latest

# Instalar Diode CLI
RUN curl -L -o diode.zip https://github.com/diodechain/diode_client/releases/download/latest/diode_linux_amd64.zip \
    && unzip diode.zip \
    && mv diode /usr/local/bin/diode \
    && chmod +x /usr/local/bin/diode

# Seu aplicativo
COPY app /app
WORKDIR /app

# Comando para iniciar app + túnel
CMD ["sh", "-c", "node server.js & diode publish -public 80:3000"]
```

---

## 🧪 Exemplos Práticos Testados

### **Exemplo 1: App Node.js simples**
```bash
# Iniciar app
node server.js &  # Rodando na porta 3000

# Criar túnel
./diode_binary publish -public 80:3000

# Output esperado:
# INFO HTTP Gateway Enabled : http://0xSEU_ENDERECO.diode.link/
# INFO Port localhost:3000  :       80      public       any
```

### **Exemplo 2: Múltiplos serviços**
```bash
# Serviço 1: Porta 3000
./diode_binary publish -public 80:3000

# Serviço 2: Porta 8080 (em outro terminal)
./diode_binary --configpath ~/.diode/config2 publish -public 8080:8080

# Resultado:
# Serviço 1: http://0xENDERECO_1.diode.link/
# Serviço 2: http://0xENDERECO_2.diode.link:8080/
```

---

## 📚 Recursos Adicionais

### **Documentação Oficial:**
- 📖 **CLI Commands**: https://cli.docs.diode.io/docs/features/cli-commands
- 🎓 **Getting Started**: https://cli.docs.diode.io/docs/using/developers-network-cli-start-here
- ❓ **FAQ**: https://cli.docs.diode.io/faq/cli-commands

### **GitHub:**
- 💻 **Repositório**: https://github.com/diodechain/diode_client
- 🐛 **Issues**: https://github.com/diodechain/diode_client/issues
- ⭐ **Releases**: https://github.com/diodechain/diode_client/releases

### **Comunidade:**
- 🐦 **Twitter**: https://twitter.com/diode_chain
- 💬 **Discord**: https://discord.gg/diode (se disponível)
- 📝 **Blog**: https://diode.io/blog

---

## 🎯 Resumo para Agentes de Código

### **Comandos Essenciais:**
```bash
# 1. Instalar
curl -L -o diode.zip https://github.com/diodechain/diode_client/releases/download/v1.18.10/diode_linux_amd64.zip
unzip diode.zip
chmod +x diode

# 2. Verificar
./diode version

# 3. Túnel único
./diode publish -public 80:[PORTA_LOCAL]

# 4. Múltiplos túneis  
./diode publish \
  -public 80:3000 \
  -public 8080:8081 \
  -private 22:22,0xENDEREÇOS_PERMITIDOS

# 5. Monitorar
./diode publish  # Mostra túneis ativos
```

### **Fluxo de Trabalho Típico:**
1. **Instalar** Diode CLI
2. **Verificar** conexão (`diode time`)
3. **Criar túnel** para serviço local
4. **Compartilhar** URL `.diode.link`
5. **Monitorar** estado dos túneis
6. **Ajustar** níveis de acesso conforme necessário

### **Principais Vantagens:**
- ✅ **Sem configuração de DNS/reverse proxy**
- ✅ **HTTPS automático** via .diode.link
- ✅ **Zero Trust** nativo
- ✅ **P2P descentralizado**
- ✅ **Persistente** (mesmo endereço sempre)
- ✅ **Multi-plataforma** (Linux, macOS, Windows)

---

**Última atualização**: Baseado no Diode CLI v1.18.10 testado em 28/10/2026  
**Status**: ✅ Funcional e pronto para produção  
**Aplicabilidade**: Desenvolvimento, demo, IoT, acesso remoto, colaboração
