import { ChannelTypeEnum } from '@novu/shared';
import { ICredentials } from '@novu/dal';
import { BaseSmsHandler } from './base.handler';
import { GupshupWhatsappSmsProvider } from '@novu/gupshup-whatsapp';

export class GupshupWhatsappSmsHandler extends BaseSmsHandler {
  constructor() {
    super('gupshup-whatsapp', ChannelTypeEnum.SMS);
  }

  buildProvider(credentials: ICredentials) {
    const config: {
      apiKey: string;
      from: string;
      appName: string;
    } = {
      apiKey: credentials.apiKey as string,
      from: credentials.from as string,
      appName: credentials.applicationId as string,
    };

    this.provider = new GupshupWhatsappSmsProvider(config);
  }
}
