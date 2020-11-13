import * as cdk from '@aws-cdk/core';
import ecs = require("@aws-cdk/aws-ecs");
import ec2 = require("@aws-cdk/aws-ec2");
import efs = require("@aws-cdk/aws-efs");
import iam = require("@aws-cdk/aws-iam");
import elbv2 = require("@aws-cdk/aws-elasticloadbalancingv2");

import { CfnCodeDeployBlueGreenHook, CfnTrafficRoutingType } from '@aws-cdk/core';
import { CfnParameter } from '@aws-cdk/core';

export class EcsFargateEfsStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    //cdk deploy --parameters VPC=vpc-d171f0a9 --parameters Subnet1=subnet-cf0c1eb6 --parameters Subnet2=subnet-366f507d
    //cdk deploy --parameters VPC=vpc-6d1d5c17 --parameters Subnet1=subnet-d95461be --parameters Subnet2=subnet-c8d1e1e6
    //cdk deploy --parameters VPC=vpc-41effb26 --parameters Subnet1=subnet-14ecff4f --parameters Subnet2=subnet-af4087c9
    

    const VPCId = new CfnParameter(this, "VPC", {
      type: "AWS::EC2::VPC::Id",
      description: "VPC Id"});
    const Subnet1 = new CfnParameter(this, "Subnet1", {
      type: "AWS::EC2::Subnet::Id",
      description: "SubnetId1"});

    const Subnet2 = new CfnParameter(this, "Subnet2", {
      type: "AWS::EC2::Subnet::Id",
      description: "SubnetId2"});

    // VPC and Cluster resource
    //const vpc = new ec2.Vpc(this, 'MyVpc', { maxAzs: 2 });
    const vpc = ec2.Vpc.fromVpcAttributes(this, "existingVpc", {
      vpcId: VPCId.valueAsString,
      availabilityZones: ['us-west-1b','us-west-1c'],
      publicSubnetIds: [Subnet1.valueAsString, Subnet2.valueAsString]
    })
    const cluster = new ecs.Cluster(this, 'FargateCluster', { vpc });

    // NFS Port
    const NFSPort = ec2.Port.tcp(2049);

    // EFS Security Group
    const filesystemSecurityGroup = new ec2.SecurityGroup(
      this,
      "efs-security",
      {
        vpc,
        allowAllOutbound: true,
      }
    );

    // ECS Service security Group
    const serviceSecurityGroup = new ec2.SecurityGroup(this, "serviceSG", {
      vpc,
      allowAllOutbound: true,
    });

    // Add Ingress and Egress rules in the SGs
    filesystemSecurityGroup.addIngressRule(serviceSecurityGroup, NFSPort);
    serviceSecurityGroup.addEgressRule(filesystemSecurityGroup, NFSPort);


    // Create FileSystem resource
    const filesystem = new efs.FileSystem(this, "efs", {
      vpc,
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_60_DAYS,
      securityGroup: filesystemSecurityGroup,
      enableAutomaticBackups: true,
    });

    // ecs task execution role
    const taskExecutionRole = new iam.Role(this, 'EcsEfsTaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    });

    // hook service role
    const hookRole = new iam.Role(this, 'codedeploybleugreenhookrole', {
      roleName: "codedeploybleugreenhookrole",
      assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com')
    });

    hookRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AWSCodeDeployFullAccess"));

    // ecs task definition
    const bluetaskDefinition = new ecs.FargateTaskDefinition(this, "BlueTaskDefinition", {
      cpu: 256,
      memoryLimitMiB: 512,
      family: "ecs-efs",
      executionRole: taskExecutionRole,
      volumes: [
        {
          name: "myefs",
          efsVolumeConfiguration: {
            fileSystemId: filesystem.fileSystemId,
            transitEncryption: "ENABLED",
          },
        },
      ],
    });

    /*
    const volumes = [
      {
        Name: "myefs",
        EFSVolumeConfiguration: {
          FilesystemId: filesystem.fileSystemId,
          TransitEncryption: "ENABLED",
        },
      },
    ]
    const cfnbluetaskDefinition = bluetaskDefinition.node.defaultChild as ecs.CfnTaskDefinition;

    // Overriding volumes object so that EFSVolumeConfiguratoin works for stack update.
    cfnbluetaskDefinition.addOverride('Properties.Volumes', volumes);
    */

    // container definition
    const containerDef = new ecs.ContainerDefinition(this, "ecs-efs-containerdef", {
      image: ecs.ContainerImage.fromRegistry("nginxdemos/hello:0.2"),
      essential: true,
      taskDefinition: bluetaskDefinition
    });

    containerDef.addPortMappings({
      containerPort: 80,
      hostPort: 80,
      protocol: ecs.Protocol.TCP
    });

    containerDef.addMountPoints({
      sourceVolume: "myefs",
      containerPath: "/var/lib/efspath",
      readOnly: false
    })

    // ELB resources 

    serviceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));
    serviceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8080));

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc,
      internetFacing: true,
      securityGroup: serviceSecurityGroup
    });

    const prodListener = loadBalancer.addListener('ProdListener', {
      port: 80,
    });

    const testListener = loadBalancer.addListener('TestListener', {
      port: 8080,
    });

    const ALBTargetGroupBlue = new elbv2.ApplicationTargetGroup(
      this,
      'ALBTargetGroupBlue',
      {
        port: 80,
        targetType: elbv2.TargetType.IP,
        vpc,
      },
    );

    prodListener.addTargetGroups('AddBlueTg', {
      targetGroups: [ALBTargetGroupBlue],
    });

    const ALBTargetGroupGreen = new elbv2.ApplicationTargetGroup(
      this,
      'ALBTargetGroupGreen',
      {
        port: 80,
        targetType: elbv2.TargetType.IP,
        vpc,
      },
    );

    testListener.addTargetGroups('AddGreenTg', {
      targetGroups: [ALBTargetGroupGreen],
    });

    const ecsService = new ecs.CfnService(this, "ecsefsfargate", {
      cluster: cluster.clusterName,
      desiredCount: 2,
      deploymentController: {
        type: ecs.DeploymentControllerType.EXTERNAL
      }
    })

    const bluetaskset = new ecs.CfnTaskSet(this, "BlueTaskSet", {
      cluster: cluster.clusterName,
      launchType: ecs.LaunchType.FARGATE,
      platformVersion: '1.4.0',
      scale: {
        unit: 'PERCENT',
        value: 100
      },
      service: ecsService.attrName,
      taskDefinition: bluetaskDefinition.taskDefinitionArn,
      loadBalancers: [
        {
          containerName: 'ecs-efs-containerdef',
          containerPort: 80,
          targetGroupArn: ALBTargetGroupBlue.targetGroupArn
        }
      ],
      networkConfiguration: {
        awsVpcConfiguration: {
          assignPublicIp: 'ENABLED',
          securityGroups: [
            serviceSecurityGroup.securityGroupId
          ],
          //subnets: vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnetIds
          subnets: [
            Subnet1.valueAsString,Subnet2.valueAsString
          ]
        }
      }
    });

    const primaryTaskset = new ecs.CfnPrimaryTaskSet(this, "PrimaryTaskSet", {
      cluster: cluster.clusterName,
      service: ecsService.attrName,
      taskSetId: bluetaskset.attrId
    })

    const codeDeployHook = new CfnCodeDeployBlueGreenHook(this, "CodeDeployBlueGreenHook", {
      serviceRole: 'codedeploybleugreenhookrole',
      trafficRoutingConfig: {
        type: CfnTrafficRoutingType.ALL_AT_ONCE
      },
      applications: [{
        target: {
          type: 'AWS::ECS::Service',
          logicalId: ecsService.logicalId
        },
        ecsAttributes: {
          taskDefinitions: [
            (bluetaskDefinition.node.defaultChild as ecs.CfnTaskDefinition).logicalId,
            "GreeTaskDefinition"
          ],
          taskSets: [
            bluetaskset.logicalId,
            "GreenTaskset"
          ],
          trafficRouting: {
            prodTrafficRoute: {
              type: 'AWS::ElasticLoadBalancingV2::Listener',
              logicalId: (prodListener.node.defaultChild as elbv2.CfnListener).logicalId
            },
            testTrafficRoute: {
              type: 'AWS::ElasticLoadBalancingV2::Listener',
              logicalId: (testListener.node.defaultChild as elbv2.CfnListener).logicalId
            },
            targetGroups: [
              (ALBTargetGroupBlue.node.defaultChild as elbv2.CfnTargetGroup).logicalId,
              (ALBTargetGroupGreen.node.defaultChild as elbv2.CfnTargetGroup).logicalId
            ]
          }
        }

      }]

    })
  }
}
