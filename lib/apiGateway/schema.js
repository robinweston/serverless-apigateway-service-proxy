'use strict'
const _ = require('lodash')

const customErrorBuilder = (type, message) => (errors) => {
  for (const error of errors) {
    switch (error.type) {
      case type:
        error.message = _.isFunction(message) ? message(error) : message
        break
      default:
        break
    }
  }
  return errors
}

// e.g. errorObject is { type1: message1, type2: message2 }
const customMultipleErrorBuilder = (errorObject) => (errors) => {
  for (const error of errors) {
    if (_.hasIn(errorObject, error.type)) {
      error.message = errorObject[error.type]
    }
  }
  return errors
}

const Joi = require('@hapi/joi')

const path = Joi.string().required()

const method = Joi.string()
  .required()
  .valid(['get', 'post', 'put', 'patch', 'options', 'head', 'delete', 'any'])
  .insensitive()

const cors = Joi.alternatives().try(
  Joi.boolean(),
  Joi.object({
    headers: Joi.array().items(Joi.string()),
    origin: Joi.string(),
    origins: Joi.array().items(Joi.string()),
    methods: Joi.array().items(method),
    maxAge: Joi.number().min(1),
    cacheControl: Joi.string(),
    allowCredentials: Joi.boolean()
  })
    .oxor('origin', 'origins') // can have one of them, but not required
    .error(customErrorBuilder('object.oxor', '"cors" can have "origin" or "origins" but not both'))
)

const authorizerId = Joi.alternatives().try(
  Joi.string(),
  Joi.object().keys({
    Ref: Joi.string().required()
  })
)

const authorizationScopes = Joi.array()

// https://hapi.dev/family/joi/?v=15.1.0#anywhencondition-options
const authorizationType = Joi.alternatives().when('authorizerId', {
  is: authorizerId.required(),
  then: Joi.string()
    .valid('CUSTOM')
    .required(),
  otherwise: Joi.alternatives().when('authorizationScopes', {
    is: authorizationScopes.required(),
    then: Joi.string()
      .valid('COGNITO_USER_POOLS')
      .required(),
    otherwise: Joi.string().valid('NONE', 'AWS_IAM', 'CUSTOM', 'COGNITO_USER_POOLS')
  })
})

// https://hapi.dev/family/joi/?v=15.1.0#objectpatternpattern-schema
const requestParameters = Joi.object().pattern(Joi.string(), Joi.string().required())

const proxy = Joi.object({
  path,
  method,
  cors,
  authorizationType,
  authorizerId,
  authorizationScopes
})
  .oxor('authorizerId', 'authorizationScopes') // can have one of them, but not required
  .error(
    customErrorBuilder('object.oxor', 'cannot set both "authorizerId" and "authorizationScopes"')
  )
  .required()

const stringOrRef = Joi.alternatives().try([
  Joi.string(),
  Joi.object().keys({
    Ref: Joi.string().required()
  })
])

const key = Joi.alternatives().try([
  Joi.string(),
  Joi.object()
    .keys({
      pathParam: Joi.string(),
      queryStringParam: Joi.string()
    })
    .xor('pathParam', 'queryStringParam')
    .error(
      customErrorBuilder(
        'object.xor',
        'key must contain "pathParam" or "queryStringParam" but not both'
      )
    )
])

const partitionKey = Joi.alternatives().try([
  Joi.string(),
  Joi.object()
    .keys({
      pathParam: Joi.string(),
      queryStringParam: Joi.string(),
      bodyParam: Joi.string()
    })
    .xor('pathParam', 'queryStringParam', 'bodyParam')
    .error(
      customErrorBuilder(
        'object.xor',
        'key must contain "pathParam" or "queryStringParam" or "bodyParam" and only one'
      )
    )
])

const allowedDynamodbActions = ['PutItem', 'GetItem', 'DeleteItem', 'UpdateItem']
const dynamodbDefaultKeyScheme = Joi.alternatives().try([
  Joi.string(),
  Joi.object()
    .keys({
      pathParam: Joi.string(),
      queryStringParam: Joi.string(),
      attributeType: Joi.string().required()
    })
    .xor('pathParam', 'queryStringParam')
    .error(
      customErrorBuilder(
        'object.xor',
        'key must contain "pathParam" or "queryStringParam" and only one'
      )
    )
])
const hashKey = Joi.when('action', {
  is: Joi.string()
    .valid(allowedDynamodbActions)
    .required(),
  then: dynamodbDefaultKeyScheme,
  otherwise: Joi.when('method', {
    is: Joi.string()
      .valid('post')
      .insensitive()
      .required(),
    then: Joi.string()
      .required()
      .error(
        customMultipleErrorBuilder({
          'string.base': [
            '"hashKey" must be a string when you define post "method" and not define',
            ' "action" expolicitly since the hashKey value is auto-generated on AWS end'
          ].join(''),
          'any.required': [
            '"hashKey" is required when you define post "method" and not define',
            ' "action" expolicitly since the hashKey value is auto-generated on AWS end'
          ].join('')
        })
      ),
    otherwise: dynamodbDefaultKeyScheme
  })
})

const rangeKey = Joi.when('action', {
  is: Joi.string()
    .valid(allowedDynamodbActions)
    .required(),
  then: dynamodbDefaultKeyScheme,
  otherwise: Joi.when('method', {
    is: Joi.string()
      .valid('post')
      .insensitive()
      .required(),
    then: Joi.string().error(
      customErrorBuilder(
        'string.base',
        [
          '"rengeKey" must be a string when you define post to "method" and not define',
          ' "action" expolicitly since the hashKey value is auto-generated on AWS end'
        ].join('')
      )
    ),
    otherwise: dynamodbDefaultKeyScheme
  })
})

const stringOrGetAtt = (propertyName, attributeName) => {
  return Joi.alternatives().try([
    Joi.string(),
    Joi.object({
      'Fn::GetAtt': Joi.array()
        .length(2)
        .ordered(
          Joi.string().required(),
          Joi.string()
            .valid(attributeName)
            .required()
        )
        .required()
    }).error(
      customErrorBuilder(
        'object.child',
        `"${propertyName}" must be in the format "{ 'Fn::GetAtt': ['<ResourceId>', '${attributeName}'] }"`
      )
    )
  ])
}

const request = Joi.object({
  template: Joi.object().required()
})

const allowedProxies = ['kinesis', 'sqs', 's3', 'sns', 'dynamodb']

const proxiesSchemas = {
  kinesis: Joi.object({
    kinesis: proxy.append({ streamName: stringOrRef.required(), partitionKey, request })
  }),
  s3: Joi.object({
    s3: proxy.append({
      action: Joi.string()
        .valid('GetObject', 'PutObject', 'DeleteObject')
        .required(),
      bucket: stringOrRef.required(),
      key: key.required()
    })
  }),
  sns: Joi.object({
    sns: proxy.append({ topicName: stringOrGetAtt('topicName', 'TopicName').required(), request })
  }),
  sqs: Joi.object({
    sqs: proxy.append({
      queueName: stringOrGetAtt('queueName', 'QueueName').required(),
      requestParameters
    })
  }),
  dynamodb: Joi.object({
    dynamodb: proxy.append({
      action: Joi.string()
        .valid(allowedDynamodbActions)
        .when('method', {
          is: Joi.string()
            .valid(['options', 'head', 'any'])
            .insensitive(),
          then: Joi.required().error(
            customErrorBuilder(
              'any.required',
              '"action" is required when you define options, head, any to "method" property'
            )
          )
        }),
      tableName: Joi.alternatives()
        .try([
          Joi.string(),
          Joi.object().keys({
            Ref: Joi.string().required()
          })
        ])
        .required(),
      hashKey,
      rangeKey
    })
  })
}

const schema = Joi.array()
  .items(...allowedProxies.map((proxyKey) => proxiesSchemas[proxyKey]))
  .error(
    customErrorBuilder('array.includes', (error) => {
      // get a detailed error why the proxy object failed the schema validation
      // Joi default message is `"value" at position <i> does not match any of the allowed types`
      const proxyKey = Object.keys(error.context.value)[0]

      let message = ''
      if (proxiesSchemas[proxyKey]) {
        // e.g. value is { kinesis: { path: '/kinesis', method: 'xxxx' } }
        const { error: proxyError } = Joi.validate(error.context.value, proxiesSchemas[proxyKey])
        message = proxyError.message
      } else {
        // e.g. value is { xxxxx: { path: '/kinesis', method: 'post' } }
        message = `Invalid APIG proxy "${proxyKey}". This plugin supported Proxies are: ${allowedProxies.join(
          ', '
        )}.`
      }
      return message
    })
  )

module.exports = schema