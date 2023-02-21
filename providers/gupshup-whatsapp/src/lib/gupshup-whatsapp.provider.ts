import {
  ChannelTypeEnum,
  ISendMessageSuccessResponse,
  ISmsOptions,
  ISmsProvider,
} from '@novu/stateless';
import axios from 'axios';

export class GupshupWhatsappSmsProvider implements ISmsProvider {
  id = 'gupshup-whatsapp';
  apiBaseUrl = 'https://api.gupshup.io/sm/api';
  channelType = ChannelTypeEnum.SMS as ChannelTypeEnum.SMS;

  constructor(
    private config: {
      apiKey: string;
      from: string;
      appName: string;
    }
  ) {}

  async sendMessage(
    options: ISmsOptions
  ): Promise<ISendMessageSuccessResponse> {
    const url = this.apiBaseUrl + '/v1/msg';
    const data = {
      channel: 'whatsapp',
      source: this.config.from,
      'src.name': this.config.appName,
      destination: options.to,
      message: options.content,
    };

    const response = await axios.post(
      url,
      new URLSearchParams(data).toString(),
      {
        headers: {
          apikey: this.config.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    return {
      id: response.data?.messageId || options.id,
      date: new Date().toDateString(),
    };
  }
}
