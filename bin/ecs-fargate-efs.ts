#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { EcsFargateEfsStack } from '../lib/ecs-fargate-efs-stack';

const app = new cdk.App();
new EcsFargateEfsStack(app, 'EcsFargateEfsStack');
