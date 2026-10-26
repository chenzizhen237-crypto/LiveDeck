use std::collections::BTreeMap;
use std::fmt;

#[derive(Debug, Clone)]
pub struct DecodeErr(pub String);

impl fmt::Display for DecodeErr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for DecodeErr {}

#[derive(Debug, Clone)]
pub struct EncodeErr(pub String);

impl fmt::Display for EncodeErr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for EncodeErr {}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
enum FieldType {
    Byte = 0,
    Short = 1,
    Int = 2,
    Long = 3,
    Float = 4,
    Double = 5,
    String1 = 6,
    String4 = 7,
    Map = 8,
    List = 9,
    StructBegin = 10,
    StructEnd = 11,
    ZeroTag = 12,
    SimpleList = 13,
}

fn parse_head(data: &[u8], pos: &mut usize) -> Result<(u8, FieldType), DecodeErr> {
    if *pos >= data.len() {
        return Err(DecodeErr("unexpected EOF while reading head".to_string()));
    }
    let b = data[*pos];
    *pos += 1;
    let ty = (b & 0x0F) as u8;
    let mut tag = (b >> 4) as u8;
    if tag == 15 {
        if *pos >= data.len() {
            return Err(DecodeErr("unexpected EOF while reading extended tag".to_string()));
        }
        tag = data[*pos];
        *pos += 1;
    }
    let field_type = match ty {
        0 => FieldType::Byte,
        1 => FieldType::Short,
        2 => FieldType::Int,
        3 => FieldType::Long,
        4 => FieldType::Float,
        5 => FieldType::Double,
        6 => FieldType::String1,
        7 => FieldType::String4,
        8 => FieldType::Map,
        9 => FieldType::List,
        10 => FieldType::StructBegin,
        11 => FieldType::StructEnd,
        12 => FieldType::ZeroTag,
        13 => FieldType::SimpleList,
        _ => {
            return Err(DecodeErr(format!(
                "unsupported field type {}",
                ty
            )))
        }
    };
    Ok((tag, field_type))
}

fn skip_value(data: &[u8], pos: &mut usize, ty: FieldType) -> Result<(), DecodeErr> {
    match ty {
        FieldType::Byte => *pos += 1,
        FieldType::Short => *pos += 2,
        FieldType::Int => *pos += 4,
        FieldType::Long => *pos += 8,
        FieldType::Float => *pos += 4,
        FieldType::Double => *pos += 8,
        FieldType::ZeroTag => {}
        FieldType::String1 => {
            if *pos >= data.len() {
                return Err(DecodeErr("unexpected EOF while reading string1 len".to_string()));
            }
            let len = data[*pos] as usize;
            *pos += 1 + len;
        }
        FieldType::String4 => {
            if *pos + 4 > data.len() {
                return Err(DecodeErr("unexpected EOF while reading string4 len".to_string()));
            }
            let len = u32::from_be_bytes([data[*pos], data[*pos + 1], data[*pos + 2], data[*pos + 3]])
                as usize;
            *pos += 4 + len;
        }
        FieldType::StructBegin => {
            loop {
                let (_t, inner_ty) = parse_head(data, pos)?;
                if inner_ty == FieldType::StructEnd {
                    break;
                }
                skip_value(data, pos, inner_ty)?;
            }
        }
        FieldType::StructEnd => {}
        FieldType::List => {
            // list: count is encoded as an int with tag=0
            let (_t, count_ty) = parse_head(data, pos)?;
            let count = read_i32_raw(data, pos, count_ty)? as usize;
            for _ in 0..count {
                let (_et, elem_ty) = parse_head(data, pos)?;
                skip_value(data, pos, elem_ty)?;
            }
        }
        FieldType::SimpleList => {
            // simple list (bytes): element head then length(int)
            let (_et, elem_ty) = parse_head(data, pos)?;
            if elem_ty != FieldType::Byte {
                return Err(DecodeErr("simple_list only supports byte".to_string()));
            }
            let (_t, len_ty) = parse_head(data, pos)?;
            let len = read_i32_raw(data, pos, len_ty)? as usize;
            *pos += len;
        }
        FieldType::Map => {
            let (_t, count_ty) = parse_head(data, pos)?;
            let count = read_i32_raw(data, pos, count_ty)? as usize;
            for _ in 0..count * 2 {
                let (_et, elem_ty) = parse_head(data, pos)?;
                skip_value(data, pos, elem_ty)?;
            }
        }
    }
    if *pos > data.len() {
        return Err(DecodeErr("unexpected EOF while skipping value".to_string()));
    }
    Ok(())
}

fn read_i32_raw(data: &[u8], pos: &mut usize, ty: FieldType) -> Result<i32, DecodeErr> {
    match ty {
        FieldType::ZeroTag => Ok(0),
        FieldType::Byte => {
            if *pos >= data.len() {
                return Err(DecodeErr("unexpected EOF while reading byte".to_string()));
            }
            let v = data[*pos] as i8 as i32;
            *pos += 1;
            Ok(v)
        }
        FieldType::Short => {
            if *pos + 2 > data.len() {
                return Err(DecodeErr("unexpected EOF while reading short".to_string()));
            }
            let v = i16::from_be_bytes([data[*pos], data[*pos + 1]]) as i32;
            *pos += 2;
            Ok(v)
        }
        FieldType::Int => {
            if *pos + 4 > data.len() {
                return Err(DecodeErr("unexpected EOF while reading int".to_string()));
            }
            let v = i32::from_be_bytes([data[*pos], data[*pos + 1], data[*pos + 2], data[*pos + 3]]);
            *pos += 4;
            Ok(v)
        }
        FieldType::Long => {
            if *pos + 8 > data.len() {
                return Err(DecodeErr("unexpected EOF while reading long".to_string()));
            }
            let v = i64::from_be_bytes([
                data[*pos],
                data[*pos + 1],
                data[*pos + 2],
                data[*pos + 3],
                data[*pos + 4],
                data[*pos + 5],
                data[*pos + 6],
                data[*pos + 7],
            ]);
            *pos += 8;
            Ok(v as i32)
        }
        _ => Err(DecodeErr(format!("type {:?} cannot be read as i32", ty))),
    }
}

fn read_i64_raw(data: &[u8], pos: &mut usize, ty: FieldType) -> Result<i64, DecodeErr> {
    match ty {
        FieldType::ZeroTag => Ok(0),
        FieldType::Byte => {
            if *pos >= data.len() {
                return Err(DecodeErr("unexpected EOF while reading byte".to_string()));
            }
            let v = data[*pos] as i8 as i64;
            *pos += 1;
            Ok(v)
        }
        FieldType::Short => {
            if *pos + 2 > data.len() {
                return Err(DecodeErr("unexpected EOF while reading short".to_string()));
            }
            let v = i16::from_be_bytes([data[*pos], data[*pos + 1]]) as i64;
            *pos += 2;
            Ok(v)
        }
        FieldType::Int => {
            if *pos + 4 > data.len() {
                return Err(DecodeErr("unexpected EOF while reading int".to_string()));
            }
            let v = i32::from_be_bytes([data[*pos], data[*pos + 1], data[*pos + 2], data[*pos + 3]]) as i64;
            *pos += 4;
            Ok(v)
        }
        FieldType::Long => {
            if *pos + 8 > data.len() {
                return Err(DecodeErr("unexpected EOF while reading long".to_string()));
            }
            let v = i64::from_be_bytes([
                data[*pos],
                data[*pos + 1],
                data[*pos + 2],
                data[*pos + 3],
                data[*pos + 4],
                data[*pos + 5],
                data[*pos + 6],
                data[*pos + 7],
            ]);
            *pos += 8;
            Ok(v)
        }
        _ => Err(DecodeErr(format!("type {:?} cannot be read as i64", ty))),
    }
}

fn read_string_raw(data: &[u8], pos: &mut usize, ty: FieldType) -> Result<String, DecodeErr> {
    match ty {
        FieldType::String1 => {
            if *pos >= data.len() {
                return Err(DecodeErr("unexpected EOF while reading string1 len".to_string()));
            }
            let len = data[*pos] as usize;
            *pos += 1;
            if *pos + len > data.len() {
                return Err(DecodeErr("unexpected EOF while reading string1".to_string()));
            }
            let s = std::str::from_utf8(&data[*pos..*pos + len])
                .map_err(|e| DecodeErr(format!("invalid utf8: {}", e)))?
                .to_string();
            *pos += len;
            Ok(s)
        }
        FieldType::String4 => {
            if *pos + 4 > data.len() {
                return Err(DecodeErr("unexpected EOF while reading string4 len".to_string()));
            }
            let len = u32::from_be_bytes([data[*pos], data[*pos + 1], data[*pos + 2], data[*pos + 3]])
                as usize;
            *pos += 4;
            if *pos + len > data.len() {
                return Err(DecodeErr("unexpected EOF while reading string4".to_string()));
            }
            let s = std::str::from_utf8(&data[*pos..*pos + len])
                .map_err(|e| DecodeErr(format!("invalid utf8: {}", e)))?
                .to_string();
            *pos += len;
            Ok(s)
        }
        _ => Err(DecodeErr(format!("type {:?} cannot be read as string", ty))),
    }
}

fn read_bytes_raw(data: &[u8], pos: &mut usize, ty: FieldType) -> Result<Vec<u8>, DecodeErr> {
    match ty {
        FieldType::SimpleList => {
            let (_et, elem_ty) = parse_head(data, pos)?;
            if elem_ty != FieldType::Byte {
                return Err(DecodeErr("simple_list only supports byte".to_string()));
            }
            let (_t, len_ty) = parse_head(data, pos)?;
            let len = read_i32_raw(data, pos, len_ty)? as usize;
            if *pos + len > data.len() {
                return Err(DecodeErr("unexpected EOF while reading bytes".to_string()));
            }
            let out = data[*pos..*pos + len].to_vec();
            *pos += len;
            Ok(out)
        }
        _ => Err(DecodeErr(format!("type {:?} cannot be read as bytes", ty))),
    }
}

/// Reads a `map<string, V>` body (after its head) using `read_value` for each value.
fn read_map_raw<V>(
    data: &[u8],
    pos: &mut usize,
    ty: FieldType,
    mut read_value: impl FnMut(&[u8], &mut usize, FieldType) -> Result<V, DecodeErr>,
) -> Result<BTreeMap<String, V>, DecodeErr> {
    if ty != FieldType::Map {
        return Err(DecodeErr(format!("type {:?} cannot be read as map", ty)));
    }
    let (_t, count_ty) = parse_head(data, pos)?;
    let count = read_i32_raw(data, pos, count_ty)? as usize;
    let mut out = BTreeMap::new();
    for _ in 0..count {
        let (_kt, key_ty) = parse_head(data, pos)?;
        let key = read_string_raw(data, pos, key_ty)?;
        let (_vt, val_ty) = parse_head(data, pos)?;
        out.insert(key, read_value(data, pos, val_ty)?);
    }
    Ok(out)
}

pub trait StructFromTars: Sized {
    fn _decode_from(decoder: &mut TarsDecoder) -> Result<Self, DecodeErr>;
}

pub struct TarsDecoder<'a> {
    data: &'a [u8],
}

impl<'a> From<&'a [u8]> for TarsDecoder<'a> {
    fn from(value: &'a [u8]) -> Self {
        Self { data: value }
    }
}

impl<'a> TarsDecoder<'a> {
    fn find_field(&self, tag: u8) -> Result<Option<(FieldType, usize)>, DecodeErr> {
        let mut pos = 0usize;
        while pos < self.data.len() {
            let (t, ty) = parse_head(self.data, &mut pos)?;
            if ty == FieldType::StructEnd {
                break;
            }
            if t == tag {
                return Ok(Some((ty, pos)));
            }
            skip_value(self.data, &mut pos, ty)?;
        }
        Ok(None)
    }

    pub fn read_int32(&mut self, tag: u8, required: bool, default: i32) -> Result<i32, DecodeErr> {
        let Some((ty, mut pos)) = self.find_field(tag)? else {
            if required {
                return Err(DecodeErr(format!("missing required int32 field tag={}", tag)));
            }
            return Ok(default);
        };
        read_i32_raw(self.data, &mut pos, ty)
    }

    pub fn read_int64(&mut self, tag: u8, required: bool, default: i64) -> Result<i64, DecodeErr> {
        let Some((ty, mut pos)) = self.find_field(tag)? else {
            if required {
                return Err(DecodeErr(format!("missing required int64 field tag={}", tag)));
            }
            return Ok(default);
        };
        read_i64_raw(self.data, &mut pos, ty)
    }

    pub fn read_string(
        &mut self,
        tag: u8,
        required: bool,
        default: String,
    ) -> Result<String, DecodeErr> {
        let Some((ty, mut pos)) = self.find_field(tag)? else {
            if required {
                return Err(DecodeErr(format!("missing required string field tag={}", tag)));
            }
            return Ok(default);
        };
        read_string_raw(self.data, &mut pos, ty)
    }

    pub fn read_bytes(
        &mut self,
        tag: u8,
        required: bool,
        default: Vec<u8>,
    ) -> Result<Vec<u8>, DecodeErr> {
        let Some((ty, mut pos)) = self.find_field(tag)? else {
            if required {
                return Err(DecodeErr(format!("missing required bytes field tag={}", tag)));
            }
            return Ok(default);
        };

        match ty {
            FieldType::SimpleList => {
                let (_et, elem_ty) = parse_head(self.data, &mut pos)?;
                if elem_ty != FieldType::Byte {
                    return Err(DecodeErr("simple_list only supports byte".to_string()));
                }
                let (_t, len_ty) = parse_head(self.data, &mut pos)?;
                let len = read_i32_raw(self.data, &mut pos, len_ty)? as usize;
                if pos + len > self.data.len() {
                    return Err(DecodeErr("unexpected EOF while reading bytes".to_string()));
                }
                Ok(self.data[pos..pos + len].to_vec())
            }
            _ => Err(DecodeErr(format!("type {:?} cannot be read as bytes", ty))),
        }
    }

    pub fn read_int8(&mut self, tag: u8, required: bool, default: i8) -> Result<i8, DecodeErr> {
        Ok(self.read_int32(tag, required, default as i32)? as i8)
    }

    pub fn read_int16(&mut self, tag: u8, required: bool, default: i16) -> Result<i16, DecodeErr> {
        Ok(self.read_int32(tag, required, default as i32)? as i16)
    }

    pub fn read_string_map(&mut self, tag: u8) -> Result<BTreeMap<String, String>, DecodeErr> {
        let Some((ty, mut pos)) = self.find_field(tag)? else {
            return Ok(BTreeMap::new());
        };
        read_map_raw(self.data, &mut pos, ty, read_string_raw)
    }

    pub fn read_bytes_map(&mut self, tag: u8) -> Result<BTreeMap<String, Vec<u8>>, DecodeErr> {
        let Some((ty, mut pos)) = self.find_field(tag)? else {
            return Ok(BTreeMap::new());
        };
        read_map_raw(self.data, &mut pos, ty, read_bytes_raw)
    }

    /// `map<string, map<string, bytes>>`, the "complex" UniAttribute layout.
    pub fn read_nested_bytes_map(
        &mut self,
        tag: u8,
    ) -> Result<BTreeMap<String, BTreeMap<String, Vec<u8>>>, DecodeErr> {
        let Some((ty, mut pos)) = self.find_field(tag)? else {
            return Ok(BTreeMap::new());
        };
        read_map_raw(self.data, &mut pos, ty, |d, p, t| {
            read_map_raw(d, p, t, read_bytes_raw)
        })
    }

    pub fn read_struct<T: StructFromTars>(
        &mut self,
        tag: u8,
        required: bool,
        default: T,
    ) -> Result<T, DecodeErr> {
        let Some((ty, pos)) = self.find_field(tag)? else {
            if required {
                return Err(DecodeErr(format!("missing required struct field tag={}", tag)));
            }
            return Ok(default);
        };
        if ty != FieldType::StructBegin {
            return Err(DecodeErr(format!("field tag={} is not struct_begin", tag)));
        }

        let start = pos;
        let end = {
            let mut scan = start;
            loop {
                let (_t, inner_ty) = parse_head(self.data, &mut scan)?;
                if inner_ty == FieldType::StructEnd {
                    break scan;
                }
                skip_value(self.data, &mut scan, inner_ty)?;
            }
        };

        let struct_bytes = &self.data[start..end];
        let mut inner = TarsDecoder::from(struct_bytes);
        T::_decode_from(&mut inner)
    }
}

pub trait StructToTars {
    fn _encode_to(&self, encoder: &mut TarsEncoder) -> Result<(), EncodeErr>;
}

/// Encodes a struct as a standalone value: struct markers at tag 0, which is
/// what TUP/UniAttribute map values contain (tars-stream's `individual_encode`).
pub fn encode_struct<T: StructToTars>(value: &T) -> Result<Vec<u8>, EncodeErr> {
    let mut encoder = TarsEncoder::new();
    encoder.write_struct(0, value)?;
    Ok(encoder.to_bytes())
}

pub struct TarsEncoder {
    buf: Vec<u8>,
}

impl TarsEncoder {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        self.buf.clone()
    }

    fn write_head(&mut self, tag: u8, ty: FieldType) {
        if tag < 15 {
            self.buf.push((tag << 4) | (ty as u8));
        } else {
            self.buf.push(0xF0 | (ty as u8));
            self.buf.push(tag);
        }
    }

    /// Writes an integer using the smallest Tars type that fits, as the reference
    /// implementations do.
    pub fn write_int64(&mut self, tag: u8, value: i64) -> Result<(), EncodeErr> {
        if value == 0 {
            self.write_head(tag, FieldType::ZeroTag);
        } else if let Ok(v) = i8::try_from(value) {
            self.write_head(tag, FieldType::Byte);
            self.buf.push(v as u8);
        } else if let Ok(v) = i16::try_from(value) {
            self.write_head(tag, FieldType::Short);
            self.buf.extend_from_slice(&v.to_be_bytes());
        } else if let Ok(v) = i32::try_from(value) {
            self.write_head(tag, FieldType::Int);
            self.buf.extend_from_slice(&v.to_be_bytes());
        } else {
            self.write_head(tag, FieldType::Long);
            self.buf.extend_from_slice(&value.to_be_bytes());
        }
        Ok(())
    }

    pub fn write_int32(&mut self, tag: u8, value: i32) -> Result<(), EncodeErr> {
        self.write_int64(tag, value as i64)
    }

    pub fn write_int16(&mut self, tag: u8, value: i16) -> Result<(), EncodeErr> {
        self.write_int64(tag, value as i64)
    }

    pub fn write_int8(&mut self, tag: u8, value: i8) -> Result<(), EncodeErr> {
        self.write_int64(tag, value as i64)
    }

    pub fn write_struct<T: StructToTars>(&mut self, tag: u8, value: &T) -> Result<(), EncodeErr> {
        self.write_head(tag, FieldType::StructBegin);
        value._encode_to(self)?;
        self.write_head(0, FieldType::StructEnd);
        Ok(())
    }

    pub fn write_string_map(
        &mut self,
        tag: u8,
        map: &BTreeMap<String, String>,
    ) -> Result<(), EncodeErr> {
        self.write_head(tag, FieldType::Map);
        self.write_int32(0, map.len() as i32)?;
        for (k, v) in map {
            self.write_string(0, k)?;
            self.write_string(1, v)?;
        }
        Ok(())
    }

    pub fn write_bytes_map(
        &mut self,
        tag: u8,
        map: &BTreeMap<String, Vec<u8>>,
    ) -> Result<(), EncodeErr> {
        self.write_head(tag, FieldType::Map);
        self.write_int32(0, map.len() as i32)?;
        for (k, v) in map {
            self.write_string(0, k)?;
            self.write_bytes(1, v)?;
        }
        Ok(())
    }

    pub fn write_string(&mut self, tag: u8, value: &String) -> Result<(), EncodeErr> {
        let bytes = value.as_bytes();
        if bytes.len() < 255 {
            self.write_head(tag, FieldType::String1);
            self.buf.push(bytes.len() as u8);
        } else {
            self.write_head(tag, FieldType::String4);
            let len = bytes.len() as u32;
            self.buf.extend_from_slice(&len.to_be_bytes());
        }
        self.buf.extend_from_slice(bytes);
        Ok(())
    }

    pub fn write_bytes(&mut self, tag: u8, bytes: &[u8]) -> Result<(), EncodeErr> {
        self.write_head(tag, FieldType::SimpleList);
        // element head: tag=0, type=byte
        self.write_head(0, FieldType::Byte);
        self.write_int32(0, bytes.len() as i32)?;
        self.buf.extend_from_slice(bytes);
        Ok(())
    }

    pub fn write_list(&mut self, tag: u8, items: &[String]) -> Result<(), EncodeErr> {
        self.write_head(tag, FieldType::List);
        self.write_int32(0, items.len() as i32)?;
        for item in items {
            self.write_string(0, item)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Pair {
        a: i64,
        b: String,
    }

    impl StructToTars for Pair {
        fn _encode_to(&self, e: &mut TarsEncoder) -> Result<(), EncodeErr> {
            e.write_int64(0, self.a)?;
            e.write_string(1, &self.b)
        }
    }

    impl StructFromTars for Pair {
        fn _decode_from(d: &mut TarsDecoder) -> Result<Self, DecodeErr> {
            Ok(Pair {
                a: d.read_int64(0, true, 0)?,
                b: d.read_string(1, true, String::new())?,
            })
        }
    }

    #[test]
    fn ints_use_smallest_type() {
        let mut e = TarsEncoder::new();
        e.write_int32(0, 0).unwrap();
        e.write_int32(1, 66).unwrap();
        e.write_int32(2, 300).unwrap();
        e.write_int64(3, 1 << 40).unwrap();
        assert_eq!(
            e.to_bytes(),
            vec![0x0C, 0x10, 66, 0x21, 0x01, 0x2C, 0x33, 0, 0, 1, 0, 0, 0, 0, 0]
        );
        let bytes = e.to_bytes();
        let mut d = TarsDecoder::from(bytes.as_slice());
        assert_eq!(d.read_int32(1, true, 0).unwrap(), 66);
        assert_eq!(d.read_int16(2, true, 0).unwrap(), 300);
        assert_eq!(d.read_int64(3, true, 0).unwrap(), 1 << 40);
    }

    #[test]
    fn nested_struct_and_bytes_map_round_trip() {
        let inner = encode_struct(&Pair { a: 7, b: "flv".into() }).unwrap();
        let mut map = BTreeMap::new();
        map.insert("tReq".to_string(), inner);
        let mut e = TarsEncoder::new();
        e.write_bytes_map(0, &map).unwrap();
        e.write_struct(1, &Pair { a: -5, b: "x".into() }).unwrap();
        let bytes = e.to_bytes();

        let mut d = TarsDecoder::from(bytes.as_slice());
        let decoded = d.read_bytes_map(0).unwrap();
        let pair = TarsDecoder::from(decoded["tReq"].as_slice())
            .read_struct(0, true, Pair { a: 0, b: String::new() })
            .unwrap();
        assert_eq!((pair.a, pair.b.as_str()), (7, "flv"));
        // Fields after a map must still be reachable (skip_value handles maps).
        let s = d.read_struct(1, true, Pair { a: 0, b: String::new() }).unwrap();
        assert_eq!((s.a, s.b.as_str()), (-5, "x"));
    }

    #[test]
    fn nested_bytes_map_round_trip() {
        let mut inner = BTreeMap::new();
        inner.insert("GetCdnTokenExResp".to_string(), vec![1u8, 2, 3]);
        let mut e = TarsEncoder::new();
        e.write_head(0, FieldType::Map);
        e.write_int32(0, 1).unwrap();
        e.write_string(0, &"tRsp".to_string()).unwrap();
        e.write_bytes_map(1, &inner).unwrap();
        let bytes = e.to_bytes();
        let out = TarsDecoder::from(bytes.as_slice()).read_nested_bytes_map(0).unwrap();
        assert_eq!(out["tRsp"]["GetCdnTokenExResp"], vec![1, 2, 3]);
    }
}
