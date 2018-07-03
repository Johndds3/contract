const UtxoRedeemableToken = artifacts.require('UTXORedeemableTokenStub')

const { ECPair, crypto } = require('bitcoinjs-lib')
const { ecsign, publicToAddress } = require('ethereumjs-util')
const { soliditySha3 } = require('web3-utils')
const { decode: decode58 } = require('bs58')
const BigNumber = require('bignumber.js')

const privateKeys = require('../data/privateKeys')
const dataMerkleTree = require('../data/merkleTree.json')
const { origin, bigZero, accounts, timeWarp } = require('./general')
const { defaultLaunchTime, defaultMaximumRedeemable } = require('./bhx')
const {
  bitcoinRootHash: defaultRootUtxoMerkleHash,
  bitcoinMerkleTree: defaultMerkleTree
} = require('./mkl')

const setupContract = async () => {
  const urt = await UtxoRedeemableToken.new(
    origin,
    defaultLaunchTime,
    defaultRootUtxoMerkleHash,
    defaultMaximumRedeemable
  )

  return urt
}

const bitcoinPrivateKeys = privateKeyIndex =>
  privateKeys[privateKeyIndex].privateKey

const getProofAndComponents = bitcoinTx => {
  const { address: originalAddress, satoshis } = bitcoinTx
  const formattedAddress = stripHexifyBase58Address(originalAddress)

  const potentialMerkleLeaf = soliditySha3(
    {
      t: 'bytes20',
      v: formattedAddress
    },
    {
      t: 'uint256',
      v: satoshis
    }
  )
  const merkleLeafBufs = defaultMerkleTree.elements.map(item =>
    Buffer.from(item, 'hex')
  )
  const hashMerkleLeafIndex = defaultMerkleTree.elements
    .map(element => element.toString('hex'))
    .indexOf(potentialMerkleLeaf.replace('0x', ''))
  const proof = defaultMerkleTree
    .getProofOrdered(
      merkleLeafBufs[hashMerkleLeafIndex],
      hashMerkleLeafIndex + 1
    )
    .map(getFormattedLeaf)

  assert(
    dataMerkleTree.elements.includes(
      potentialMerkleLeaf.replace('0x', ''),
      'resulting potentialMerkleLeaf should be included in dataMerkleTree elements'
    )
  )

  return {
    potentialMerkleLeaf,
    proof,
    formattedAddress,
    satoshis
  }
}

// get pub key by concatenating x and y coordinates
const retrievePubKey = wif => {
  const ecPair = ECPair.fromWIF(wif)

  return (
    '0x' +
    ecPair.Q.affineX.toBuffer(32).toString('hex') +
    ecPair.Q.affineY.toBuffer(32).toString('hex')
  )
}

const retrieveBitcoinAddress = wif => ECPair.fromWIF(wif).getAddress()

// sign and format resulting signature components
const signEthAddress = (wif, ethAddress) => {
  const ecPair = ECPair.fromWIF(wif)
  let { v, r, s } = ecsign(
    crypto.sha256(Buffer.from(ethAddress.replace('0x', ''), 'hex')),
    ecPair.d.toBuffer()
  )

  v = parseInt(v, 10)
  r = '0x' + r.toString('hex')
  s = '0x' + s.toString('hex')

  return { v, r, s }
}

// remove 1st byte mainnet designation & 4 byte checksum at end & convert to hex
const stripHexifyBase58Address = address =>
  '0x' +
  decode58(address)
    .slice(1, 21)
    .toString('hex')

const getFormattedLeaf = leafBuffer => '0x' + leafBuffer.toString('hex')

const timeWarpRelativeToLaunchTime = async (urt, seconds, moveAhead) => {
  const launchTime = await urt.launchTime()
  const currentBlock = await web3.eth.getBlock(web3.eth.blockNumber)
  let targetSeconds
  assert(
    currentBlock.timestamp < launchTime.toNumber(),
    'cannot warp backwards'
  )
  if (moveAhead) {
    // eslint-disable-next-line no-console
    console.log(`warping to ${seconds} seconds ahead of bet launchTime...`)
    targetSeconds = launchTime
      .sub(currentBlock.timestamp)
      .add(seconds)
      .toNumber()
  } else {
    // eslint-disable-next-line no-console
    console.log(`warping to ${seconds} seconds before bet launchTime...`)
    targetSeconds = launchTime
      .sub(currentBlock.timestamp)
      .sub(seconds)
      .toNumber()
  }

  assert(
    currentBlock.timestamp < launchTime.add(targetSeconds).toNumber(),
    'cannot warp backwards'
  )

  await timeWarp(targetSeconds)
}

const testInitialization = async urt => {
  const contractOrigin = await urt.origin()
  const launchTime = await urt.launchTime()
  const lastUpdatedWeek = await urt.lastUpdatedWeek()
  const rootUTXOMerkleTreeHash = await urt.rootUTXOMerkleTreeHash()
  const totalRedeemed = await urt.totalRedeemed()
  const maximumRedeemable = await urt.maximumRedeemable()

  assert.equal(contractOrigin, origin, 'contractOrigin should match origin')
  assert.equal(
    launchTime.toString(),
    defaultLaunchTime.toString(),
    'launchTime should match defaultLaunchTime'
  )
  assert.equal(
    lastUpdatedWeek.toString(),
    bigZero.toString(),
    'lastUpdatedWeek should start as 0'
  )
  assert.equal(
    rootUTXOMerkleTreeHash,
    defaultRootUtxoMerkleHash,
    'rootUTXOMerkleTreeHash should match defaultRootUtxoMerkleHash'
  )
  assert.equal(
    totalRedeemed.toString(),
    bigZero.toString(),
    'totalRedeemed should start as 0'
  )
  assert.equal(
    maximumRedeemable.toString(),
    defaultMaximumRedeemable.toString(),
    'maximumRedeemable should match defaultMaximumRedeemable'
  )
}

const testValidateSignature = async (
  urt,
  address,
  testedAddress,
  message,
  shouldBeValid
) => {
  assert(
    accounts.includes(address),
    'address used for signing must be included in testing accounts'
  )
  const messageHash = web3.sha3(message)
  const signature = web3.eth.sign(address, messageHash).replace('0x', '')
  const r = '0x' + signature.slice(0, 64)
  const s = '0x' + signature.slice(64, 128)
  // see: https://github.com/trufflesuite/ganache-cli/issues/243
  const v = new BigNumber('0x' + signature.slice(128, 130)).add(27).toNumber()

  const valid = await urt.validateSignature(
    messageHash,
    v,
    r,
    s,
    testedAddress,
    true
  )

  if (shouldBeValid) {
    assert(valid, 'signed message should validate')
  } else {
    assert(!valid, 'signed message should NOT validate')
  }
}

const testEcsdaVerify = async (urt, bitcoinPrivateKey, ethAddress) => {
  const { v, r, s } = signEthAddress(bitcoinPrivateKey, ethAddress)
  const pubKey = retrievePubKey(bitcoinPrivateKey)

  const verified = await urt.ecdsaVerify(ethAddress, pubKey, v, r, s)

  assert(verified, 'ecsdaVerify should verify properly formatted signature')
}

const testPubKeyToEthereumAddress = async (urt, bitcoinPrivateKey) => {
  const pubKey = retrievePubKey(bitcoinPrivateKey)
  const actualAddress = '0x' + publicToAddress(pubKey).toString('hex')

  const address = await urt.pubKeyToEthereumAddress(pubKey)

  assert.equal(
    address,
    actualAddress,
    'pubKeyToEthereumAddress should match actualAddress'
  )
}

const testPubKeyToBitcoinAddress = async (urt, bitcoinPrivateKey) => {
  const rawHexAddress = stripHexifyBase58Address(
    retrieveBitcoinAddress(bitcoinPrivateKey)
  )

  const pubKey = retrievePubKey(bitcoinPrivateKey)
  const resultAddress = await urt.pubKeyToBitcoinAddress(pubKey, true)

  assert.equal(
    resultAddress,
    rawHexAddress,
    'resultAddress should match rawHexAddress'
  )
}

const testCanRedeemUtxoHash = async (urt, potentialMerkleLeaf, proof) => {
  const canRedeem = await urt.canRedeemUtxoHash(potentialMerkleLeaf, proof)

  assert(
    canRedeem,
    'should be able to redeem with merkleLeaf and correct proof'
  )
}

const testCanRedeemUtxo = async (urt, proof, formattedAddress, satoshis) => {
  const canRedeem = await urt.canRedeemUtxo(formattedAddress, satoshis, proof)

  assert(
    canRedeem,
    'should be able to redeem using correct merkleLeaf components'
  )
}

const testRedeemUtxo = async (
  urt,
  proof,
  satoshis,
  bitcoinPrivateKey,
  config
) => {
  const pubKey = retrievePubKey(bitcoinPrivateKey)
  const { v, r, s } = signEthAddress(bitcoinPrivateKey, config.from)
  const preRedeemerBalance = await urt.balanceOf(config.from)

  await urt.redeemUtxo(satoshis, proof, pubKey, true, v, r, s, config)

  const postRedeemerBalance = await urt.balanceOf(config.from)
  const expectedRedeemAmount = await urt.getRedeemAmount(satoshis)

  assert.equal(
    postRedeemerBalance.sub(preRedeemerBalance).toString(),
    expectedRedeemAmount.toString(),
    'redeemer token balance should be incremented by expectedRedeemAmount'
  )
}

module.exports = {
  setupContract,
  bitcoinPrivateKeys,
  getProofAndComponents,
  timeWarpRelativeToLaunchTime,
  testInitialization,
  testValidateSignature,
  testEcsdaVerify,
  testPubKeyToEthereumAddress,
  testPubKeyToBitcoinAddress,
  testCanRedeemUtxoHash,
  testCanRedeemUtxo,
  testRedeemUtxo
}
