import * as amqp from 'amqplib';
export declare const HOTEL_PROBE_QUEUE = "hotel_probe_jobs";
export declare function getChannel(): Promise<amqp.Channel | null>;
export declare function closeConnection(): Promise<void>;
