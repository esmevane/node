import { LoggingConfiguration } from 'Configuration'

import { ClaimControllerConfiguration } from './ClaimControllerConfiguration'
import { ServiceConfiguration } from './ServiceConfiguration'

export interface StorageConfiguration extends LoggingConfiguration, ServiceConfiguration, ClaimControllerConfiguration {
  readonly ipfsUrl: string
  readonly dbUrl: string
  readonly rabbitmqUrl: string
}
