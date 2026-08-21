@description('Regiao do Container Apps e do armazenamento persistente.')
param location string = resourceGroup().location

@description('Nome estavel da API do WhatsApp.')
param appName string = 'norium-whatsapp-api'

@description('Container Apps Environment existente compartilhado com o Norium.')
param managedEnvironmentName string

@description('Referencia imutavel da imagem publicada no registro privado.')
param containerImage string

@description('Servidor do registro privado de imagens.')
param registryServer string = 'ghcr.io'

@description('Usuario do registro privado de imagens.')
param registryUsername string = 'T-Lucas43'

@secure()
@description('Token de leitura do registro privado, recuperado do cofre do Container Apps.')
param registryPassword string

@description('Callback HTTPS do Norium que recebe eventos do WhatsApp.')
param noriumWebhookUrl string

@description('Origem web autorizada para chamadas de navegador.')
param allowedOrigin string

@description('Usuario do Norium que recebe as conversas desta sessao.')
param noriumOwnerUserId string

@secure()
@minLength(32)
param noriumApiKey string

@secure()
@minLength(32)
param adminApiKey string

@secure()
@minLength(32)
param webhookHmacSecret string

@secure()
@minLength(32)
param noriumWebhookSecret string

var storageAccountName = 'stw${uniqueString(subscription().subscriptionId, resourceGroup().id)}'
var fileShareName = 'whatsapp-data'
var environmentStorageName = 'whatsappdata'
var publicUrl = 'https://${appName}.${managedEnvironment.properties.defaultDomain}'
var tags = {
  application: 'norium-whatsapp-api'
  environment: 'production'
  managedBy: 'bicep'
  dataClassification: 'confidential'
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2025-06-01' = {
  name: storageAccountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    allowSharedKeyAccess: true
    defaultToOAuthAuthentication: false
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2025-06-01' = {
  parent: storageAccount
  name: 'default'
  properties: {}
}

resource fileShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2025-06-01' = {
  parent: fileService
  name: fileShareName
  properties: {
    enabledProtocols: 'SMB'
    shareQuota: 5
  }
}

resource managedEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  name: managedEnvironmentName
}

resource environmentStorage 'Microsoft.App/managedEnvironments/storages@2023-05-01' = {
  parent: managedEnvironment
  name: environmentStorageName
  properties: {
    azureFile: {
      accountName: storageAccount.name
      accountKey: storageAccount.listKeys().keys[0].value
      shareName: fileShare.name
      accessMode: 'ReadWrite'
    }
  }
}

resource containerApp 'Microsoft.App/containerApps@2025-01-01' = {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 2
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 8080
        transport: 'auto'
      }
      registries: [
        {
          server: registryServer
          username: registryUsername
          passwordSecretRef: 'ghcr-token'
        }
      ]
      secrets: [
        {
          name: 'ghcr-token'
          value: registryPassword
        }
        {
          name: 'norium-api-key'
          value: noriumApiKey
        }
        {
          name: 'admin-api-key'
          value: adminApiKey
        }
        {
          name: 'webhook-hmac-secret'
          value: webhookHmacSecret
        }
        {
          name: 'norium-webhook-secret'
          value: noriumWebhookSecret
        }
      ]
    }
    template: {
      terminationGracePeriodSeconds: 60
      containers: [
        {
          name: 'whatsapp-api'
          image: containerImage
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '8080' }
            { name: 'SESSION_ID', value: 'norium' }
            { name: 'SESSION_DATA_PATH', value: '/data/sessions' }
            { name: 'OUTBOX_PATH', value: '/data/outbox' }
            { name: 'CHROME_PATH', value: '/usr/bin/chromium' }
            { name: 'PUPPETEER_SKIP_CHROMIUM_DOWNLOAD', value: 'true' }
            { name: 'NORIUM_API_KEY', secretRef: 'norium-api-key' }
            { name: 'ADMIN_API_KEY', secretRef: 'admin-api-key' }
            { name: 'WEBHOOK_HMAC_SECRET', secretRef: 'webhook-hmac-secret' }
            { name: 'NORIUM_WEBHOOK_URL', value: noriumWebhookUrl }
            { name: 'NORIUM_WEBHOOK_SECRET', secretRef: 'norium-webhook-secret' }
            { name: 'NORIUM_OWNER_USER_ID', value: noriumOwnerUserId }
            { name: 'ALLOWED_ORIGINS', value: allowedOrigin }
            { name: 'TRUST_PROXY', value: '1' }
            { name: 'RATE_LIMIT_PER_MINUTE', value: '120' }
            { name: 'SEND_RATE_LIMIT_PER_MINUTE', value: '30' }
            { name: 'MAX_BODY_MB', value: '25' }
            { name: 'LOG_LEVEL', value: 'info' }
          ]
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          volumeMounts: [
            {
              volumeName: 'whatsapp-data'
              mountPath: '/data'
            }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/health'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 30
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 30
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 5
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
      volumes: [
        {
          name: 'whatsapp-data'
          storageType: 'AzureFile'
          storageName: environmentStorage.name
        }
      ]
    }
  }
}

output containerAppName string = containerApp.name
output publicUrl string = publicUrl
output persistentDataPath string = '/data'
