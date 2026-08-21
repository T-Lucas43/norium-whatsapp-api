@description('Regiao do registro privado de imagens.')
param location string = resourceGroup().location

@description('Nome globalmente unico do Azure Container Registry.')
param registryName string = 'nw${uniqueString(subscription().subscriptionId, resourceGroup().id)}'

var tags = {
  application: 'norium-whatsapp-api'
  environment: 'production'
  managedBy: 'bicep'
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: true
    dataEndpointEnabled: false
    publicNetworkAccess: 'Enabled'
    policies: {
      quarantinePolicy: {
        status: 'disabled'
      }
      trustPolicy: {
        type: 'Notary'
        status: 'disabled'
      }
    }
  }
}

output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
