#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { EcsFargateEfsStack } from '../lib/ecs-fargate-efs-stack';

const app = new cdk.App();
//const prod = Environment(account="413988070266", region="us-west-2")

const stack = new EcsFargateEfsStack(app, 'EcsFargateEfsStack');

stack.templateOptions.transforms = ['AWS::CodeDeployBlueGreen'];
